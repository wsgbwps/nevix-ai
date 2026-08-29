package application

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// TaskWorker drains the PostgreSQL generation queue: claim with FOR UPDATE
// SKIP LOCKED under a short lease, perform external Provider/Storage work
// strictly outside transactions, then persist every state migration inside
// one short verified transaction whose guarded updates are the durable twin
// of the domain one-way state machine. Local timeouts, lease expiries, and
// worker crashes never fabricate business outcomes: an unidentified submit
// outcome converges to indeterminate, and only the provider's authoritative
// verdict may end work as timed_out (spec #150).
type TaskWorker struct {
	tasks       domain.GenerationTaskRepository
	materials   domain.MaterialRepository
	connections domain.ConnectionSignals
	store       domain.BlobStore
	prober      domain.MediaProber
	gateway     domain.ProviderGateway
	notify      InvalidationSink
	runner      domain.WriteRunner
	fetch       *http.Client

	leaseOwner string
	lease      time.Duration
	pollEvery  time.Duration
	idleEvery  time.Duration

	pressure providerPressure
}

func NewTaskWorker(
	tasks domain.GenerationTaskRepository,
	materials domain.MaterialRepository,
	connections domain.ConnectionSignals,
	store domain.BlobStore,
	prober domain.MediaProber,
	gateway domain.ProviderGateway,
	notify InvalidationSink,
	runner domain.WriteRunner,
	leaseOwner string,
) *TaskWorker {
	return &TaskWorker{
		tasks: tasks, materials: materials, connections: connections, store: store,
		prober: prober, gateway: gateway, notify: notify, runner: runner,
		fetch:      &http.Client{Timeout: 5 * time.Minute},
		leaseOwner: leaseOwner,
		lease:      30 * time.Second,
		pollEvery:  3 * time.Second,
		idleEvery:  time.Second,
	}
}

// Run drains the queue until the context is cancelled. The first worker
// error is returned so the composition root's RunWorkers contract surfaces
// it; transient claim misses just idle.
func (w *TaskWorker) Run(ctx context.Context) error {
	for {
		if ctx.Err() != nil {
			return nil
		}
		item, ok, err := w.tasks.ClaimNextQueueItem(ctx, w.leaseOwner, w.lease)
		if err != nil {
			return err
		}
		if !ok {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(w.idleEvery):
			}
			continue
		}
		if err := w.process(ctx, item); err != nil {
			// One item's failure never stops the drain; the item stays
			// claimed until its lease expires or a later pass reschedules it.
			slog.Error("creation: queue item processing failed", "task_id", item.TaskID.String(), "error", err)
		}
	}
}

// freshTaskState re-reads the task, slots, and active job inside the persist
// transaction so every guarded transition's from-set matches reality: the
// submit marker commits before the external call, so pass-start snapshots
// are always one step behind the durable truth.
func (w *TaskWorker) freshTaskState(ctx context.Context, tx domain.TxExecutor, taskID domain.UUID) (domain.GenerationTask, []domain.GenerationSlot, domain.ProviderJob, error) {
	return w.tasks.GetForOwnerInTx(ctx, tx, domain.UUID{}, taskID)
}

// slotUpdate is one pending slot verdict for the persist transaction.
type slotUpdate struct {
	Index  int
	Status domain.SlotStatus
	Reason *domain.FailureReason
	Result *domain.SlotResult
}

// process drives one claimed item through at most one external step plus its
// persist transaction. Every branch re-reads the task row so a pass that
// lost a race reschedules instead of fabricating state.
func (w *TaskWorker) process(ctx context.Context, item domain.ClaimedQueueItem) error {
	task, slots, job, err := w.tasks.GetForWorker(ctx, item.TaskID)
	if err != nil {
		return err
	}
	// A retired item whose task already converged: park the queue row.
	if domain.TaskIsTerminal(task.Status) && domain.JobIsTerminal(job.Status) {
		return w.park(ctx, item.QueueID)
	}
	media := task.Spec.MediaType

	switch {
	case task.CancelRequested && !domain.TaskIsTerminal(task.Status):
		return w.driveCancel(ctx, item.QueueID, task, slots, job, media)

	case job.Status == domain.JobPending:
		return w.driveSubmit(ctx, item.QueueID, task, job, media)

	case job.Status == domain.JobSubmitting && job.ExternalRef != nil:
		return w.drivePoll(ctx, item.QueueID, task, slots, job, media)

	case job.Status == domain.JobSubmitting && job.ExternalRef == nil && job.Outcome != nil && *job.Outcome == domain.JobOutcomeTransientRejected:
		// The prior submit ended in a definitively identified transient
		// rejection (explicit 429/503 — nothing executed externally), so a
		// bounded re-submit is provably safe.
		return w.driveSubmit(ctx, item.QueueID, task, job, media)

	case job.Status == domain.JobSubmitting && job.ExternalRef == nil:
		// A previous pass marked the submit as started but crashed before
		// the outcome landed. The outcome can never be identified now — the
		// honest convergence is indeterminate, never a guessed re-submit.
		return w.convergeIndeterminate(ctx, item.QueueID, task.ID)

	case job.Status == domain.JobProcessing && job.ExternalRef != nil:
		return w.drivePoll(ctx, item.QueueID, task, slots, job, media)

	case job.Status == domain.JobCancelling && job.ExternalRef != nil:
		return w.driveCancellingJob(ctx, item.QueueID, task, slots, job, media)

	case domain.JobIsTerminal(job.Status) && !domain.TaskIsTerminal(task.Status):
		// Persist-phase crash recovery: settled slots aggregate, unfinished
		// ones converge from the terminal job verdict.
		return w.convergeFromTerminalJob(ctx, item.QueueID, task, slots, job, media)

	default:
		return w.park(ctx, item.QueueID)
	}
}

// holdUntil reports the in-memory provider pressure window for one
// connection+media key, or the zero time when the key is clear.
func (w *TaskWorker) holdUntil(key string) time.Time {
	return w.pressure.until(key)
}

func (w *TaskWorker) recordSuccess(key string) {
	w.pressure.recordSuccess(key)
}

func (w *TaskWorker) recordRateLimited(key string, retryAfter *time.Duration) time.Time {
	return w.pressure.recordRateLimited(key, retryAfter)
}

func (w *TaskWorker) recordUnavailable(key string) (time.Time, bool) {
	return w.pressure.recordUnavailable(key)
}

// pressureKey namespaces the in-memory backoff state per connection+media.
func pressureKey(connectionID domain.UUID, media domain.MediaType) string {
	return connectionID.String() + "|" + string(media)
}

func (w *TaskWorker) activeConnectionKey(ctx context.Context) (domain.UUID, bool) {
	connection, err := w.connections.GetActive(ctx)
	if err != nil || connection.ID == (domain.UUID{}) {
		return domain.UUID{}, false
	}
	return connection.ID, true
}

// driveSubmit performs the external submit for a pending job. The pending →
// submitting marker is persisted BEFORE the external call so a crash during
// the call can only converge as indeterminate — never a blind re-submit.
func (w *TaskWorker) driveSubmit(ctx context.Context, queueID domain.UUID, task domain.GenerationTask, job domain.ProviderJob, media domain.MediaType) error {
	key, haveConnection := w.activeConnectionKey(ctx)
	_ = key
	if !haveConnection {
		// No active connection: unstarted calls wait; a terminated
		// connection with live tasks is prevented by the delete guard.
		return w.reschedule(ctx, queueID, time.Now().Add(5*time.Second), true)
	}
	connection, err := w.connections.GetActive(ctx)
	if err != nil {
		return err
	}
	if connection.AdminState == domain.AdminStatePaused {
		// Pause blocks not-yet-started provider calls; accepted jobs keep
		// converging. The hold does not consume the bounded retry budget.
		return w.reschedule(ctx, queueID, time.Now().Add(5*time.Second), true)
	}
	pressure := pressureKey(connection.ID, media)
	if until := w.holdUntil(pressure); until.After(time.Now()) {
		return w.reschedule(ctx, queueID, until, true)
	}

	// Marker transaction: job pending→submitting (first attempt) or the
	// transient-rejection marker cleared (bounded re-submit), plus the
	// task's own queued→submitting edge.
	marked := false
	err = w.runner.Run(ctx, func(sc domain.WriteScope) error {
		if job.Status == domain.JobPending {
			jobOK, err := w.tasks.TransitionJob(ctx, sc.Tx(), job.ID,
				[]domain.JobStatus{domain.JobPending}, domain.JobSubmitting, nil)
			if err != nil || !jobOK {
				return err
			}
		} else {
			// Bounded re-submit: the statement clears the transient-rejection
			// marker, so a crash before the new call's answer still reads as
			// an unidentified outcome.
			if _, err := w.tasks.TransitionJob(ctx, sc.Tx(), job.ID,
				[]domain.JobStatus{domain.JobSubmitting}, domain.JobSubmitting, nil); err != nil {
				return err
			}
		}
		taskOK, err := w.tasks.TransitionTask(ctx, sc.Tx(), task.ID,
			[]domain.TaskStatus{task.Status}, domain.TaskSubmitting, nil)
		if err != nil {
			return err
		}
		if !taskOK {
			// Cancel converged first (queued→cancelled); the worker will
			// reconcile from the intent marker on the next pass.
			return nil
		}
		marked = true
		return nil
	})
	if err != nil || !marked {
		return err
	}

	// External submit, outside any transaction.
	outcome, submitErr := w.gateway.Submit(ctx, w.buildSubmitRequest(ctx, task, media))
	switch {
	case submitErr == nil:
		w.recordSuccess(pressure)
		return w.persistSubmitOutcome(ctx, queueID, task.ID, job.ID, task.OwnerID, outcome)
	case domain.IsSubmitIndeterminate(submitErr):
		return w.convergeIndeterminate(ctx, queueID, task.ID)
	case domain.IsCreditBlocked(submitErr):
		return w.convergeCreditBlocked(ctx, queueID, task.ID)
	case domain.IsRateLimited(submitErr):
		until := w.recordRateLimited(pressure, domain.RetryAfterOf(submitErr))
		return w.parkTransientRejection(ctx, queueID, job.ID, until)
	case domain.IsProviderUnavailable(submitErr):
		until, alert := w.recordUnavailable(pressure)
		if alert {
			slog.Error("creation: provider availability degraded — repeated 503 pressure", "media", string(media))
		}
		return w.parkTransientRejection(ctx, queueID, job.ID, until)
	default:
		// Definitive rejection (classified reason) converges the task.
		return w.persistFailure(ctx, queueID, task, job, submitErr)
	}
}

// parkTransientRejection records the identified transient rejection and
// reschedules the item: the job stays submitting but licensed for a bounded
// re-submit at the backoff instant.
func (w *TaskWorker) parkTransientRejection(ctx context.Context, queueID, jobID domain.UUID, until time.Time) error {
	return w.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := w.tasks.MarkJobSubmitRetryable(ctx, sc.Tx(), jobID); err != nil {
			return err
		}
		return w.tasks.ReleaseQueueItem(ctx, sc.Tx(), queueID, until)
	})
}

// buildSubmitRequest assembles the transport-ready request from the frozen
// specification and the creator's stored materials.
func (w *TaskWorker) buildSubmitRequest(ctx context.Context, task domain.GenerationTask, media domain.MediaType) domain.SubmitRequest {
	req := domain.SubmitRequest{
		Media:      media,
		Model:      task.Spec.Model,
		Mode:       task.Spec.Mode,
		Prompt:     task.Spec.Prompt,
		Quantity:   task.Spec.Quantity,
		Ratio:      task.Spec.Ratio,
		Resolution: task.Spec.Resolution,
		DurationS:  task.Spec.DurationSeconds,
		References: make([]domain.GatewayReference, 0, len(task.Spec.References)),
	}
	for _, reference := range task.Spec.References {
		data := w.referenceDataURL(ctx, task.OwnerID, reference.MaterialID)
		if data == "" {
			continue
		}
		req.References = append(req.References, domain.GatewayReference{Role: reference.Role, Kind: reference.Kind, Data: data})
	}
	return req
}

// referenceDataURL loads one creator-owned material and encodes it as a data
// URL, bounded by the kind's ingestion ceiling.
func (w *TaskWorker) referenceDataURL(ctx context.Context, owner, materialID domain.UUID) string {
	material, err := w.materials.GetForRead(ctx, owner, materialID)
	if err != nil {
		return ""
	}
	reader, _, err := w.store.Open(ctx, material.BlobKey, domain.FullBlobRange)
	if err != nil {
		return ""
	}
	defer reader.Close()
	limited := io.LimitReader(reader, material.Kind.SizeLimit()+1)
	raw, err := io.ReadAll(limited)
	if err != nil || int64(len(raw)) > material.Kind.SizeLimit() {
		return ""
	}
	return "data:" + material.MimeType + ";base64," + base64.StdEncoding.EncodeToString(raw)
}

// persistSubmitOutcome lands a successful submit: sync outputs go straight
// to transfer+persist; async references reschedule for polling.
func (w *TaskWorker) persistSubmitOutcome(ctx context.Context, queueID domain.UUID, taskID, jobID domain.UUID, owner domain.UUID, outcome domain.SubmitOutcome) error {
	if len(outcome.Outputs) == 0 {
		// Async submission accepted with an external identity: park in
		// submitting until the first poll promotes it to processing.
		return w.runner.Run(ctx, func(sc domain.WriteScope) error {
			if _, err := w.tasks.TransitionJob(ctx, sc.Tx(), jobID,
				[]domain.JobStatus{domain.JobSubmitting}, domain.JobSubmitting, strPtr(outcome.ExternalRef)); err != nil {
				return err
			}
			if err := w.tasks.ReleaseQueueItem(ctx, sc.Tx(), queueID, time.Now().Add(w.pollEvery)); err != nil {
				return err
			}
			notifyOwner(sc, w.notify, owner)
			return nil
		})
	}
	// Synchronous provider answer: transfer outside the tx, then persist.
	// notify wiring happens inside persistOutputs.
	return w.transferAndPersist(ctx, queueID, taskID, jobID, domain.JobSubmitting, domain.JobCompleted, outcome.Outputs, nil)
}

// drivePoll polls one accepted external job and converges its verdict.
func (w *TaskWorker) drivePoll(ctx context.Context, queueID domain.UUID, task domain.GenerationTask, slots []domain.GenerationSlot, job domain.ProviderJob, media domain.MediaType) error {
	pressure, ok := w.activeConnectionKey(ctx)
	_ = pressure
	pressureName := ""
	if ok {
		pressureName = pressureKey(pressure, media)
	}
	outcome, err := w.gateway.Poll(ctx, *job.ExternalRef)
	if err != nil {
		if domain.IsCreditBlocked(err) {
			return w.convergeCreditBlocked(ctx, queueID, task.ID)
		}
		if domain.IsRateLimited(err) {
			until := w.recordRateLimited(pressureName, domain.RetryAfterOf(err))
			return w.reschedule(ctx, queueID, until, false)
		}
		if domain.IsProviderUnavailable(err) {
			// Polling is provably safe to retry with a bounded budget.
			return w.reschedule(ctx, queueID, time.Now().Add(w.pollEvery), false)
		}
		return err
	}
	w.recordSuccess(pressureName)

	switch outcome.Status {
	case domain.PollProcessing:
		return w.runner.Run(ctx, func(sc domain.WriteScope) error {
			if _, err := w.tasks.TransitionJob(ctx, sc.Tx(), job.ID,
				[]domain.JobStatus{domain.JobSubmitting}, domain.JobProcessing, nil); err != nil {
				return err
			}
			// The task may still be submitting on the first poll.
			if _, err := w.tasks.TransitionTask(ctx, sc.Tx(), task.ID,
				[]domain.TaskStatus{task.Status}, domain.TaskProcessing, nil); err != nil {
				return err
			}
			if err := w.tasks.ReleaseQueueItem(ctx, sc.Tx(), queueID, time.Now().Add(w.pollEvery)); err != nil {
				return err
			}
			notifyOwner(sc, w.notify, task.OwnerID)
			return nil
		})
	case domain.PollCompleted:
		return w.transferAndPersist(ctx, queueID, task.ID, job.ID, job.Status, domain.JobCompleted, outcome.Outputs, nil)
	case domain.PollFailed:
		return w.persistJobFailure(ctx, queueID, task, slots, job, outcome.Reason)
	case domain.PollCancelled:
		return w.persistJobTerminal(ctx, queueID, task, slots, job, domain.JobCancelled, nil)
	case domain.PollTimedOut:
		// Provider-authoritative timeout is the only business timed_out.
		return w.persistJobTerminal(ctx, queueID, task, slots, job, domain.JobTimedOut, nil)
	}
	return w.reschedule(ctx, queueID, time.Now().Add(w.pollEvery), false)
}

// driveCancel converges the cancel intent for a task with accepted work.
func (w *TaskWorker) driveCancel(ctx context.Context, queueID domain.UUID, task domain.GenerationTask, slots []domain.GenerationSlot, job domain.ProviderJob, media domain.MediaType) error {
	switch {
	case job.Status == domain.JobPending:
		// Nothing external started: cancel converges immediately.
		return w.persistJobTerminal(ctx, queueID, task, slots, job, domain.JobCancelled, nil)
	case job.Status == domain.JobSubmitting || job.Status == domain.JobProcessing:
		// Record the job-level cancel intent; the next pass drives the
		// provider cancel and waits for the authoritative verdict.
		return w.runner.Run(ctx, func(sc domain.WriteScope) error {
			if _, err := w.tasks.TransitionJob(ctx, sc.Tx(), job.ID,
				[]domain.JobStatus{job.Status}, domain.JobCancelling, nil); err != nil {
				return err
			}
			if _, err := w.tasks.TransitionTask(ctx, sc.Tx(), task.ID,
				[]domain.TaskStatus{task.Status}, domain.TaskCancelling, nil); err != nil {
				return err
			}
			if err := w.tasks.ReleaseQueueItem(ctx, sc.Tx(), queueID, time.Now()); err != nil {
				return err
			}
			notifyOwner(sc, w.notify, task.OwnerID)
			return nil
		})
	case job.Status == domain.JobCancelling:
		return w.driveCancellingJob(ctx, queueID, task, slots, job, media)
	default:
		// Terminal job with cancel intent: finish the aggregation.
		return w.convergeFromTerminalJob(ctx, queueID, task, slots, job, media)
	}
}

// driveCancellingJob asks the provider to cancel one accepted job and keeps
// polling until the authoritative verdict lands. Outputs obtained before or
// during cancelling still transfer (best-effort cancel, never discard work).
func (w *TaskWorker) driveCancellingJob(ctx context.Context, queueID domain.UUID, task domain.GenerationTask, slots []domain.GenerationSlot, job domain.ProviderJob, media domain.MediaType) error {
	if err := w.gateway.Cancel(ctx, *job.ExternalRef); err != nil && !domain.IsProviderUnavailable(err) {
		// Cancel requests are best effort; provider-side rejection of the
		// cancel leaves polling as the authoritative convergence.
		_ = err
	}
	return w.drivePoll(ctx, queueID, task, slots, job, media)
}

// convergeIndeterminate ends an unidentifiable submit: job indeterminate,
// all slots indeterminate, task failed with the indeterminate cause. The
// system never retries it automatically; only the creator's explicit redo
// (a new task) proceeds, after a repeat-risk confirmation.
func (w *TaskWorker) convergeIndeterminate(ctx context.Context, queueID domain.UUID, taskID domain.UUID) error {
	cause := domain.TerminalCauseProviderIndeterminate
	return w.runner.Run(ctx, func(sc domain.WriteScope) error {
		_, _, freshJob, err := w.freshTaskState(ctx, sc.Tx(), taskID)
		if err != nil {
			return err
		}
		if !domain.JobIsTerminal(freshJob.Status) {
			if _, err := w.tasks.TransitionJob(ctx, sc.Tx(), freshJob.ID,
				[]domain.JobStatus{freshJob.Status}, domain.JobIndeterminate, nil); err != nil {
				return err
			}
		}
		if err := w.finalizeTask(ctx, sc.Tx(), taskID, domain.TaskFailed, &cause); err != nil {
			return err
		}
		indeterminateStatus, indeterminateReason := domain.SlotVerdictForJob(domain.JobIndeterminate, nil)
		if err := w.settleUnsettledSlots(ctx, sc.Tx(), taskID, indeterminateStatus, indeterminateReason); err != nil {
			return err
		}
		if _, err := w.tasks.ReleaseReservation(ctx, sc.Tx(), taskID); err != nil {
			return err
		}
		if err := w.tasks.RetireQueueItem(ctx, sc.Tx(), queueID); err != nil {
			return err
		}
		notifyOwnerForTask(ctx, sc, w.notify, taskID)
		return nil
	})
}

// convergeCreditBlocked persists the connection-level 402 fact, then fails
// the task with action_required slots. Older tasks keep converging through
// their own lifecycle; admission blocks new ones until an admin clears it.
func (w *TaskWorker) convergeCreditBlocked(ctx context.Context, queueID domain.UUID, taskID domain.UUID) error {
	err := w.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := w.connections.MarkCreditBlocked(ctx, sc.Tx()); err != nil {
			return err
		}
		_, _, freshJob, err := w.freshTaskState(ctx, sc.Tx(), taskID)
		if err != nil {
			return err
		}
		if !domain.JobIsTerminal(freshJob.Status) {
			if _, err := w.tasks.TransitionJob(ctx, sc.Tx(), freshJob.ID,
				[]domain.JobStatus{freshJob.Status}, domain.JobFailed, nil); err != nil {
				return err
			}
		}
		reason := domain.ReasonActionRequired
		if err := w.finalizeTask(ctx, sc.Tx(), taskID, domain.TaskFailed, nil); err != nil {
			return err
		}
		if err := w.settleUnsettledSlots(ctx, sc.Tx(), taskID, domain.SlotFailed, &reason); err != nil {
			return err
		}
		if _, err := w.tasks.ReleaseReservation(ctx, sc.Tx(), taskID); err != nil {
			return err
		}
		if err := w.tasks.RetireQueueItem(ctx, sc.Tx(), queueID); err != nil {
			return err
		}
		notifyOwnerForTask(ctx, sc, w.notify, taskID)
		return nil
	})
	return err
}

// persistFailure converges a definitive submit rejection onto the task.
func (w *TaskWorker) persistFailure(ctx context.Context, queueID domain.UUID, task domain.GenerationTask, job domain.ProviderJob, submitErr error) error {
	reason := domain.ClassifyFailureReason(submitErr)
	jobStatus := domain.JobFailed
	if domain.IsProviderTimedOut(submitErr) {
		jobStatus = domain.JobTimedOut
	}
	return w.persistJobTerminal(ctx, queueID, task, nil, job, jobStatus, &reason)
}

// persistJobFailure converges a poll-answered failure with its classified
// reason onto every unsettled slot.
func (w *TaskWorker) persistJobFailure(ctx context.Context, queueID domain.UUID, task domain.GenerationTask, slots []domain.GenerationSlot, job domain.ProviderJob, reason *domain.FailureReason) error {
	return w.persistJobTerminal(ctx, queueID, task, slots, job, domain.JobFailed, reason)
}

// persistJobTerminal lands one terminal job verdict: job transition, slot
// projection, task aggregation, reservation release, and queue retirement
// in one transaction.
func (w *TaskWorker) persistJobTerminal(ctx context.Context, queueID domain.UUID, task domain.GenerationTask, slots []domain.GenerationSlot, job domain.ProviderJob, jobStatus domain.JobStatus, reason *domain.FailureReason) error {
	return w.runner.Run(ctx, func(sc domain.WriteScope) error {
		if _, err := w.tasks.TransitionJob(ctx, sc.Tx(), job.ID,
			[]domain.JobStatus{job.Status}, jobStatus, nil); err != nil {
			return err
		}
		slotStatus, slotReason := domain.SlotVerdictForJob(jobStatus, reason)
		if err := w.settleUnsettledSlots(ctx, sc.Tx(), task.ID, slotStatus, slotReason); err != nil {
			return err
		}
		if err := w.aggregateAndFinalize(ctx, sc.Tx(), task.ID); err != nil {
			return err
		}
		if _, err := w.tasks.ReleaseReservation(ctx, sc.Tx(), task.ID); err != nil {
			return err
		}
		if err := w.tasks.RetireQueueItem(ctx, sc.Tx(), queueID); err != nil {
			return err
		}
		notifyOwner(sc, w.notify, task.OwnerID)
		return nil
	})
}

// transferAndPersist transfers provider outputs to the module's storage and
// persists the succeeded slots plus the task's terminal aggregation.
func (w *TaskWorker) transferAndPersist(ctx context.Context, queueID domain.UUID, taskID, jobID domain.UUID, fromJob, toJob domain.JobStatus, outputs []domain.GatewayOutput, _ *domain.FailureReason) error {
	task, slots, _, err := w.tasks.GetForWorker(ctx, taskID)
	if err != nil {
		return err
	}
	updates, err := w.transferOutputs(ctx, task, slots, outputs)
	if err != nil {
		return err
	}
	return w.runner.Run(ctx, func(sc domain.WriteScope) error {
		if _, err := w.tasks.TransitionJob(ctx, sc.Tx(), jobID,
			[]domain.JobStatus{fromJob}, toJob, nil); err != nil {
			return err
		}
		// Only a persisting phase may end in a success-shaped aggregation.
		if _, err := w.tasks.TransitionTask(ctx, sc.Tx(), task.ID,
			[]domain.TaskStatus{task.Status}, domain.TaskPersisting, nil); err != nil {
			return err
		}
		for _, update := range updates {
			if _, err := w.tasks.WriteSlotVerdict(ctx, sc.Tx(), task.ID, update.Index, update.Status, update.Reason, update.Result); err != nil {
				return err
			}
		}
		if err := w.aggregateAndFinalize(ctx, sc.Tx(), task.ID); err != nil {
			return err
		}
		if _, err := w.tasks.ReleaseReservation(ctx, sc.Tx(), task.ID); err != nil {
			return err
		}
		if err := w.tasks.RetireQueueItem(ctx, sc.Tx(), queueID); err != nil {
			return err
		}
		notifyOwner(sc, w.notify, task.OwnerID)
		return nil
	})
}

// transferOutputs streams every provider output into the module's storage,
// verifies each blob through the authoritative probe, and produces slot
// updates. Outputs already exceeding the slot count are ignored (provider
// over-supply never forms results); slot shortfall marks the missing slots
// failed as temporarily unavailable so the creator can retry them.
func (w *TaskWorker) transferOutputs(ctx context.Context, task domain.GenerationTask, slots []domain.GenerationSlot, outputs []domain.GatewayOutput) ([]slotUpdate, error) {
	updates := make([]slotUpdate, 0, len(slots))
	claimed := map[int]bool{}
	for _, output := range outputs {
		// Find the next not-yet-claimed unsettled slot (slots arrive
		// index-ordered); the in-memory slots slice never reflects updates,
		// so the claimed set guards the assignment.
		index := -1
		for _, slot := range slots {
			if slot.Status == nil && !claimed[slot.Index] {
				index = slot.Index
				break
			}
		}
		if index < 0 {
			break // provider over-supply: never form extra results
		}
		claimed[index] = true
		result, err := w.transferOne(ctx, task.ID, index, output)
		if err != nil {
			reason := domain.ReasonTemporarilyUnavailable
			updates = append(updates, slotUpdate{Index: index, Status: domain.SlotFailed, Reason: &reason})
			continue
		}
		updates = append(updates, slotUpdate{Index: index, Status: domain.SlotSucceeded, Result: result})
	}
	// Remaining unsettled slots without outputs: provider shortfall.
	for _, slot := range slots {
		if slot.Status != nil || claimed[slot.Index] {
			continue
		}
		reason := domain.ReasonTemporarilyUnavailable
		updates = append(updates, slotUpdate{Index: slot.Index, Status: domain.SlotFailed, Reason: &reason})
	}
	return updates, nil
}

// transferOne streams one output into storage and probes it. The blob key
// is deterministic per (task, slot), so a lease-expiry retry overwrites the
// same object instead of duplicating results.
func (w *TaskWorker) transferOne(ctx context.Context, taskID domain.UUID, index int, output domain.GatewayOutput) (*domain.SlotResult, error) {
	blobKey := domain.GenerationResultBlobKey(taskID, index)
	// The download stream is bounded by the defensive per-output ceiling;
	// the blob store enforces the same limit on its side.
	reader, err := w.openProviderOutput(ctx, output.URL)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	put, err := w.store.Put(ctx, blobKey, reader, domain.GenerationResultMaxBytes)
	if err != nil {
		return nil, err
	}
	stored, size, err := w.store.Open(ctx, blobKey, domain.FullBlobRange)
	if err != nil {
		return nil, err
	}
	defer stored.Close()
	identified, err := w.prober.Identify(stored)
	if err != nil {
		return nil, err
	}
	_ = size
	return &domain.SlotResult{
		Mime:       identified.Facts.MimeType,
		ByteSize:   put.ByteSize,
		Checksum:   put.SHA256Sum[:],
		BlobKey:    blobKey,
		WidthPx:    identified.Facts.WidthPx,
		HeightPx:   identified.Facts.HeightPx,
		DurationMS: identified.Facts.DurationMS,
	}, nil
}

// convergeFromTerminalJob finishes a task whose job already settled but
// whose slots/aggregation did not (persist-phase crash recovery).
func (w *TaskWorker) convergeFromTerminalJob(ctx context.Context, queueID domain.UUID, task domain.GenerationTask, slots []domain.GenerationSlot, job domain.ProviderJob, media domain.MediaType) error {
	if job.Status == domain.JobCompleted && job.ExternalRef != nil {
		// A completed async job's outputs stay re-pollable; a persist-phase
		// crash can retry the transfer without a new external generation.
		if outcome, err := w.gateway.Poll(ctx, *job.ExternalRef); err == nil &&
			outcome.Status == domain.PollCompleted && len(outcome.Outputs) > 0 {
			return w.transferAndPersist(ctx, queueID, task.ID, job.ID, domain.JobCompleted, domain.JobCompleted, outcome.Outputs, nil)
		}
	}
	return w.persistJobTerminal(ctx, queueID, task, slots, job, job.Status, nil)
}

// settleUnsettledSlots writes one verdict to every still-projected slot.
func (w *TaskWorker) settleUnsettledSlots(ctx context.Context, tx domain.TxExecutor, taskID domain.UUID, status domain.SlotStatus, reason *domain.FailureReason) error {
	rows, err := tx.Query(ctx, `
		SELECT slot_index FROM creation_generation_slots WHERE task_id = $1 AND status IS NULL`, taskID)
	if err != nil {
		return fmt.Errorf("creation: list unsettled slots: %w", err)
	}
	defer rows.Close()
	indexes := []int{}
	for rows.Next() {
		var index int
		if err := rows.Scan(&index); err != nil {
			return err
		}
		indexes = append(indexes, index)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, index := range indexes {
		if _, err := w.tasks.WriteSlotVerdict(ctx, tx, taskID, index, status, reason, nil); err != nil {
			return err
		}
	}
	return nil
}

// finalizeTask performs one guarded task transition from the fresh in-tx
// status; false positives cannot happen because the WHERE clause is the
// fresh status itself.
func (w *TaskWorker) finalizeTask(ctx context.Context, tx domain.TxExecutor, taskID domain.UUID, to domain.TaskStatus, cause *domain.TerminalCause) error {
	freshTask, _, _, err := w.freshTaskState(ctx, tx, taskID)
	if err != nil {
		return err
	}
	if domain.TaskIsTerminal(freshTask.Status) {
		return nil
	}
	_, err = w.tasks.TransitionTask(ctx, tx, taskID,
		[]domain.TaskStatus{freshTask.Status}, to, cause)
	return err
}

// aggregateAndFinalize computes the task's terminal verdict once every slot
// has one and performs the guarded terminal transition. The reservation is
// released by the caller in the same transaction after a winning transition.
func (w *TaskWorker) aggregateAndFinalize(ctx context.Context, tx domain.TxExecutor, taskID domain.UUID) error {
	task, slots, _, err := w.tasks.GetForOwnerInTx(ctx, tx, domain.UUID{}, taskID)
	if err != nil {
		return err
	}
	if domain.TaskIsTerminal(task.Status) {
		return nil
	}
	if len(slots) != task.SlotCount {
		return nil
	}
	outcomes := make([]domain.SlotOutcome, 0, len(slots))
	for _, slot := range slots {
		if slot.Status == nil {
			return nil // not every slot settled yet; aggregation waits
		}
		outcomes = append(outcomes, domain.SlotOutcome{Index: slot.Index, Status: *slot.Status})
	}
	status, cause, ok := domain.AggregateTaskStatus(task.SlotCount, outcomes)
	if !ok {
		return nil
	}
	_, err = w.tasks.TransitionTask(ctx, tx, task.ID,
		[]domain.TaskStatus{task.Status}, status, cause)
	return err
}

// park retires a queue item whose task and job have both converged.
func (w *TaskWorker) park(ctx context.Context, queueID domain.UUID) error {
	return w.runner.Run(ctx, func(sc domain.WriteScope) error {
		return w.tasks.RetireQueueItem(ctx, sc.Tx(), queueID)
	})
}

// reschedule drops the lease and requeues the item; resetBudget also zeroes
// the attempt counter for holds that must not consume the bounded retry
// budget (pause, provider pressure).
func (w *TaskWorker) reschedule(ctx context.Context, queueID domain.UUID, runAfter time.Time, resetBudget bool) error {
	return w.runner.Run(ctx, func(sc domain.WriteScope) error {
		if resetBudget {
			if err := w.tasks.ResetQueueBudget(ctx, sc.Tx(), queueID); err != nil {
				return err
			}
		}
		return w.tasks.ReleaseQueueItem(ctx, sc.Tx(), queueID, runAfter)
	})
}

// notifyOwner registers the post-commit invalidation effect for one owner.
func notifyOwner(sc domain.WriteScope, notify InvalidationSink, owner domain.UUID) {
	if notify == nil {
		return
	}
	sc.AfterCommit(func() { notify.NotifyGenerationChanged(owner) })
}

// notifyOwnerForTask resolves the owner inside the transaction and registers
// the post-commit invalidation effect for it.
func notifyOwnerForTask(ctx context.Context, sc domain.WriteScope, notify InvalidationSink, taskID domain.UUID) {
	if notify == nil {
		return
	}
	var owner domain.UUID
	if err := sc.Tx().QueryRow(ctx,
		`SELECT owner_user_id FROM creation_generation_tasks WHERE id = $1`, taskID).Scan(&owner); err != nil {
		return
	}
	sc.AfterCommit(func() { notify.NotifyGenerationChanged(owner) })
}

// providerPressure is the in-memory 429/503 backoff state. The persistent
// 402 credit block lives in the database; these cooldowns are process-local
// by design (bounded windows that self-heal).
type providerPressure struct {
	mu              sync.Mutex
	rateUntil       map[string]time.Time
	cooldownUntil   map[string]time.Time
	cooldownStrikes map[string]int
	strikeStart     map[string]time.Time
}

func (p *providerPressure) until(key string) time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.rateUntil == nil {
		return time.Time{}
	}
	if until, ok := p.rateUntil[key]; ok && until.After(time.Now()) {
		return until
	}
	if until, ok := p.cooldownUntil[key]; ok && until.After(time.Now()) {
		return until
	}
	return time.Time{}
}

func (p *providerPressure) recordSuccess(key string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.rateUntil, key)
	delete(p.cooldownUntil, key)
	delete(p.cooldownStrikes, key)
	delete(p.strikeStart, key)
}

func (p *providerPressure) recordRateLimited(key string, retryAfter *time.Duration) time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.rateUntil == nil {
		p.rateUntil = map[string]time.Time{}
		p.cooldownUntil = map[string]time.Time{}
		p.cooldownStrikes = map[string]int{}
		p.strikeStart = map[string]time.Time{}
	}
	strike := 0
	if until, ok := p.rateUntil[key]; ok && until.After(time.Now()) {
		// consecutive strikes within pressure
		if start, ok := p.strikeStart[key]; ok && time.Since(start) < 10*time.Minute {
			strike = p.cooldownStrikes[key] + 1
		}
	}
	if p.strikeStart[key].IsZero() {
		p.strikeStart[key] = time.Now()
	}
	until := time.Now().Add(domain.BackoffLadder(strike))
	if retryAfter != nil {
		until = time.Now().Add(*retryAfter)
	}
	p.rateUntil[key] = until
	p.cooldownStrikes[key] = strike
	return until
}

func (p *providerPressure) recordUnavailable(key string) (time.Time, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cooldownStrikes == nil {
		p.rateUntil = map[string]time.Time{}
		p.cooldownUntil = map[string]time.Time{}
		p.cooldownStrikes = map[string]int{}
		p.strikeStart = map[string]time.Time{}
	}
	now := time.Now()
	strikes := p.cooldownStrikes[key]
	if start, ok := p.strikeStart[key]; !ok || now.Sub(start) > 10*time.Minute {
		strikes = 0
		p.strikeStart[key] = now
	}
	strikes++
	p.cooldownStrikes[key] = strikes
	until := now.Add(domain.CooldownLadder(strikes - 1))
	p.cooldownUntil[key] = until
	// Three triggers inside ten minutes raise one operations alert; only a
	// recorded success re-arms it.
	alert := strikes == 3
	return until, alert
}

// openProviderOutput streams one provider temporary URL for transfer. The
// reader is consumed under the defensive per-output ceiling by the blob
// store's bounded copy loop; the URL never reaches logs or responses.
func (w *TaskWorker) openProviderOutput(ctx context.Context, url string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("creation: build provider output request: %w", err)
	}
	resp, err := w.fetch.Do(req)
	if err != nil {
		return nil, fmt.Errorf("creation: fetch provider output: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("creation: provider output fetch returned %d", resp.StatusCode)
	}
	return resp.Body, nil
}

func strPtr(value string) *string { return &value }
