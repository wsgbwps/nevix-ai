package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
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
// strictly outside transactions, then persist every state migration through
// the single verdict application routine (ADR-0019) — the worker itself only
// routes via domain.NextAction and adjudicates external outcomes via
// domain.VerdictFor. Local timeouts, lease expiries, and worker crashes never
// fabricate business outcomes: an unidentified submit outcome converges to
// indeterminate, and only the provider's authoritative verdict may end work
// as timed_out (spec #150).
type TaskWorker struct {
	tasks       domain.GenerationTaskRepository
	materials   domain.MaterialRepository
	connections domain.ConnectionSignals
	credentials domain.CallCredentialSource
	storage     *ObjectStorageConnectionService
	prober      domain.MediaProber
	gateway     domain.ProviderGateway
	assets      domain.MediaAssetRepository
	notify      InvalidationSink
	runner      domain.WriteRunner
	fetch       *http.Client

	leaseOwner string
	lease      time.Duration
	pollEvery  time.Duration
	idleEvery  time.Duration

	pressure providerPressure
	applier  verdictApplier
}

func NewTaskWorker(
	tasks domain.GenerationTaskRepository,
	materials domain.MaterialRepository,
	connections domain.ConnectionSignals,
	credentials domain.CallCredentialSource,
	storage *ObjectStorageConnectionService,
	prober domain.MediaProber,
	gateway domain.ProviderGateway,
	assets domain.MediaAssetRepository,
	notify InvalidationSink,
	runner domain.WriteRunner,
	leaseOwner string,
) *TaskWorker {
	return &TaskWorker{
		tasks: tasks, materials: materials, connections: connections, credentials: credentials,
		storage: storage, prober: prober, gateway: gateway, assets: assets, notify: notify, runner: runner,
		fetch:      &http.Client{Timeout: 5 * time.Minute},
		leaseOwner: leaseOwner,
		lease:      30 * time.Second,
		pollEvery:  3 * time.Second,
		idleEvery:  time.Second,
		applier:    verdictApplier{tasks: tasks, connections: connections, assets: assets, notify: notify, gateway: gateway},
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

func kernelState(task domain.GenerationTask, job domain.ProviderJob) domain.KernelState {
	return domain.KernelState{
		TaskStatus:      task.Status,
		CancelRequested: task.CancelRequested,
		JobStatus:       job.Status,
		HasExternalRef:  job.ExternalRef != nil,
		JobOutcome:      job.Outcome,
		SubmitAttempts:  job.SubmitAttempts,
	}
}

// process drives one claimed item through at most one external step plus
// its persist transaction.
func (w *TaskWorker) process(ctx context.Context, item domain.ClaimedQueueItem) error {
	task, _, job, err := w.tasks.GetForWorker(ctx, item.TaskID)
	if err != nil {
		return err
	}
	state := kernelState(task, job)
	action, err := domain.NextAction(state)
	if err != nil {
		return err
	}
	media := task.Spec.MediaType
	switch action {
	case domain.ActionPark:
		return w.park(ctx, item.QueueID)
	case domain.ActionSubmit:
		return w.driveSubmit(ctx, item.QueueID, task, job, state, media)
	case domain.ActionPoll:
		return w.drivePoll(ctx, item.QueueID, task, job, state, media)
	case domain.ActionCancelJob:
		return w.driveCancellingJob(ctx, item.QueueID, task, job, state, media)
	case domain.ActionRecordCancel:
		return w.applyEvent(ctx, item.QueueID, task.ID, state,
			domain.KernelEvent{Kind: domain.EventCancelAccepted}, time.Now())
	case domain.ActionConvergeCancelled:
		return w.applyEvent(ctx, item.QueueID, task.ID, state,
			domain.KernelEvent{Kind: domain.EventCancelUnstarted}, time.Time{})
	case domain.ActionConvergeLost:
		return w.applyEvent(ctx, item.QueueID, task.ID, state,
			domain.KernelEvent{Kind: domain.EventOutcomeLost}, time.Time{})
	case domain.ActionConvergeSettled:
		return w.convergeFromTerminalJob(ctx, item.QueueID, task, job, state)
	}
	return nil
}

func (w *TaskWorker) applyRun(ctx context.Context, queueID, taskID domain.UUID, verdict domain.KernelVerdict) error {
	return w.runner.Run(ctx, func(sc domain.WriteScope) error {
		_, _, err := w.applier.apply(ctx, sc, domain.UUID{}, queueID, taskID, verdict)
		return err
	})
}

// applyEvent applies one observed outcome's verdict; terminal outcomes
// retire the row, released holds pace at runAfter.
func (w *TaskWorker) applyEvent(ctx context.Context, queueID, taskID domain.UUID, state domain.KernelState, event domain.KernelEvent, runAfter time.Time) error {
	verdict, err := domain.VerdictFor(state, event)
	if err != nil {
		return err
	}
	verdict.RunAfter = runAfter
	return w.applyRun(ctx, queueID, taskID, verdict)
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
func (w *TaskWorker) driveSubmit(ctx context.Context, queueID domain.UUID, task domain.GenerationTask, job domain.ProviderJob, state domain.KernelState, media domain.MediaType) error {
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
	request, err := w.buildSubmitRequest(ctx, task, media)
	if err != nil {
		return w.rejectReferencePreparation(ctx, queueID, task.ID, state, err)
	}
	prepared, err := w.gateway.PrepareReferences(ctx, job.ID, request)
	if err != nil {
		if len(request.References) == 0 {
			return w.reschedule(ctx, queueID, time.Now().Add(5*time.Second), true)
		}
		return w.rejectReferencePreparation(ctx, queueID, task.ID, state, err)
	}
	// Resolve the decrypted Provider Key only after every reference is ready.
	// A resolution failure means nothing external executed, so the item holds
	// without spending the submit budget. The plaintext exists only until the
	// call returns.
	credential, err := w.credentials.ActiveCallCredential(ctx)
	if err != nil {
		if ctx.Err() == nil {
			releaseProviderTransfers(w.gateway, job.ID, job.Status, len(request.References))
		}
		return w.reschedule(ctx, queueID, time.Now().Add(5*time.Second), true)
	}

	// Marker transaction: ok=false means a cancel converged first — stand
	// down; nothing external may run.
	marker := domain.KernelVerdict{Kind: domain.VerdictSubmitMarker, TaskTo: domain.TaskSubmitting}
	var attempts int
	marked := false
	err = w.runner.Run(ctx, func(sc domain.WriteScope) error {
		licensed, ok, runErr := w.applier.apply(ctx, sc, domain.UUID{}, queueID, task.ID, marker)
		attempts, marked = licensed, ok
		return runErr
	})
	if err != nil {
		releaseProviderTransfers(w.gateway, job.ID, job.Status, len(request.References))
		return err
	}
	if !marked {
		releaseProviderTransfers(w.gateway, job.ID, domain.JobCancelled, len(request.References))
		return nil
	}
	// The marker's durable count is the budget the transient verdict spends.
	state.SubmitAttempts = attempts

	// External submit, outside any transaction.
	outcome, submitErr := w.gateway.Submit(ctx, credential, prepared)
	switch {
	case submitErr == nil:
		w.recordSuccess(pressure)
		if len(outcome.Outputs) == 0 {
			return w.applyEvent(ctx, queueID, task.ID, state,
				domain.KernelEvent{Kind: domain.EventSubmitAccepted, ExternalRef: strPtr(outcome.ExternalRef)},
				time.Now().Add(w.pollEvery))
		}
		// Synchronous provider answer: transfer outside the tx, then persist.
		return w.transferAndPersist(ctx, queueID, task.ID, outcome.Outputs)
	case domain.IsSubmitIndeterminate(submitErr):
		return w.applyEvent(ctx, queueID, task.ID, state,
			domain.KernelEvent{Kind: domain.EventOutcomeLost, Diagnostic: domain.FailureDiagnosticOf(submitErr)}, time.Time{})
	case domain.IsCreditBlocked(submitErr):
		return w.applyEvent(ctx, queueID, task.ID, state,
			domain.KernelEvent{Kind: domain.EventCreditBlocked, Diagnostic: domain.FailureDiagnosticOf(submitErr)}, time.Time{})
	case domain.IsRateLimited(submitErr) || domain.IsProviderUnavailable(submitErr):
		var until time.Time
		if domain.IsRateLimited(submitErr) {
			until = w.recordRateLimited(pressure, domain.RetryAfterOf(submitErr))
		} else {
			var alert bool
			until, alert = w.recordUnavailable(pressure)
			if alert {
				slog.Error("creation: provider availability degraded — repeated 503 pressure", "media", string(media))
			}
		}
		verdict, err := domain.VerdictFor(state, domain.KernelEvent{
			Kind:       domain.EventSubmitTransient,
			Reason:     failureReasonPtr(domain.ClassifyFailureReason(submitErr)),
			Diagnostic: domain.FailureDiagnosticOf(submitErr),
		})
		if err != nil {
			return err
		}
		if verdict.Kind == domain.VerdictRetryHold {
			return w.holdSubmitRetry(ctx, queueID, job.ID, until)
		}
		return w.applyRun(ctx, queueID, task.ID, verdict)
	default:
		kind := domain.EventSubmitRejected
		if domain.IsProviderTimedOut(submitErr) {
			kind = domain.EventSubmitTimedOut
		}
		return w.applyEvent(ctx, queueID, task.ID, state,
			domain.KernelEvent{Kind: kind, Reason: failureReasonPtr(domain.ClassifyFailureReason(submitErr)), Diagnostic: domain.FailureDiagnosticOf(submitErr)}, time.Time{})
	}
}

// holdSubmitRetry records the identified transient rejection on the
// submitting job, licensing the next marker at the backoff instant.
func (w *TaskWorker) holdSubmitRetry(ctx context.Context, queueID, jobID domain.UUID, until time.Time) error {
	return w.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := w.tasks.MarkJobSubmitRetryable(ctx, sc.Tx(), jobID); err != nil {
			return err
		}
		return w.tasks.ReleaseQueueItem(ctx, sc.Tx(), queueID, until)
	})
}

// buildSubmitRequest assembles the provider-neutral request from the frozen
// specification and the creator's stored materials.
func (w *TaskWorker) buildSubmitRequest(ctx context.Context, task domain.GenerationTask, media domain.MediaType) (domain.SubmitRequest, error) {
	req := domain.SubmitRequest{
		Media:      media,
		Model:      task.Spec.Model,
		Mode:       task.Spec.Mode,
		Prompt:     task.Spec.Prompt,
		Quantity:   task.Spec.Quantity,
		Ratio:      task.Spec.Ratio,
		Resolution: task.Spec.Resolution,
		DurationS:  task.Spec.DurationSeconds,
		References: make([]domain.ReferenceSource, 0, len(task.Spec.References)),
	}
	if len(task.Spec.References) == 0 {
		return req, nil
	}
	for _, reference := range task.Spec.References {
		material, err := w.materials.GetForRead(ctx, task.OwnerID, reference.MaterialID)
		if err != nil {
			return domain.SubmitRequest{}, err
		}
		if material.Kind != reference.Kind || material.ClaimsVersion != reference.ClaimsVersion {
			return domain.SubmitRequest{}, domain.ErrInvalidReferenceSource
		}
		source, err := w.storage.ReferenceSource(material, reference.Role)
		if err != nil {
			return domain.SubmitRequest{}, err
		}
		req.References = append(req.References, source)
	}
	return req, nil
}

func (w *TaskWorker) rejectReferencePreparation(ctx context.Context, queueID, taskID domain.UUID, state domain.KernelState, err error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	reason := domain.ReasonInternalError
	code := "reference_preparation_failed"
	message := "A referenced material could not be prepared"
	switch {
	case errors.Is(err, domain.ErrObjectStorageConfiguration):
		reason = domain.ReasonActionRequired
		code = "reference_storage_action_required"
		message = "Object Storage configuration requires administrator action"
	case errors.Is(err, context.DeadlineExceeded),
		errors.Is(err, domain.ErrObjectStorageUnavailable),
		errors.Is(err, domain.ErrObjectStorageRateLimited):
		reason = domain.ReasonTemporarilyUnavailable
		code = "reference_storage_temporarily_unavailable"
		message = "Reference preparation is temporarily unavailable"
	case errors.Is(err, domain.ErrMaterialNotFound), errors.Is(err, domain.ErrSessionNotFound), errors.Is(err, domain.ErrBlobNotFound):
		code = "reference_material_unavailable"
		message = "A referenced material is no longer available"
	}
	return w.applyEvent(ctx, queueID, taskID, state, domain.KernelEvent{
		Kind: domain.EventSubmitRejected, Reason: &reason,
		Diagnostic: domain.NewFailureDiagnostic(domain.DiagnosticSourceStorage, code, message, nil, "", ""),
	}, time.Time{})
}

// drivePoll polls one accepted external job and converges its verdict.
func (w *TaskWorker) drivePoll(ctx context.Context, queueID domain.UUID, task domain.GenerationTask, job domain.ProviderJob, state domain.KernelState, media domain.MediaType) error {
	pressure, ok := w.activeConnectionKey(ctx)
	_ = pressure
	pressureName := ""
	if ok {
		pressureName = pressureKey(pressure, media)
	}
	// Polling is provably side-effect free, so a credential resolution
	// failure is a plain transient reschedule.
	credential, err := w.credentials.ActiveCallCredential(ctx)
	if err != nil {
		return w.reschedule(ctx, queueID, time.Now().Add(w.pollEvery), false)
	}
	outcome, err := w.gateway.Poll(ctx, credential, *job.ExternalRef)
	if err != nil {
		if domain.IsCreditBlocked(err) {
			return w.applyEvent(ctx, queueID, task.ID, state,
				domain.KernelEvent{Kind: domain.EventCreditBlocked, Diagnostic: domain.FailureDiagnosticOf(err)}, time.Time{})
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
		return w.applyEvent(ctx, queueID, task.ID, state,
			domain.KernelEvent{Kind: domain.EventPollProcessing}, time.Now().Add(w.pollEvery))
	case domain.PollCompleted:
		return w.transferAndPersist(ctx, queueID, task.ID, outcome.Outputs)
	case domain.PollFailed:
		return w.applyEvent(ctx, queueID, task.ID, state,
			domain.KernelEvent{Kind: domain.EventPollFailed, Reason: outcome.Reason, Diagnostic: outcome.Diagnostic}, time.Time{})
	case domain.PollCancelled:
		return w.applyEvent(ctx, queueID, task.ID, state,
			domain.KernelEvent{Kind: domain.EventPollCancelled}, time.Time{})
	case domain.PollTimedOut:
		// Provider-authoritative timeout is the only business timed_out.
		return w.applyEvent(ctx, queueID, task.ID, state,
			domain.KernelEvent{Kind: domain.EventPollTimedOut, Diagnostic: outcome.Diagnostic}, time.Time{})
	}
	return w.reschedule(ctx, queueID, time.Now().Add(w.pollEvery), false)
}

// driveCancellingJob asks the provider to cancel one accepted job and keeps
// polling until the authoritative verdict lands. Outputs obtained before or
// during cancelling still transfer (best-effort cancel, never discard work).
func (w *TaskWorker) driveCancellingJob(ctx context.Context, queueID domain.UUID, task domain.GenerationTask, job domain.ProviderJob, state domain.KernelState, media domain.MediaType) error {
	credential, err := w.credentials.ActiveCallCredential(ctx)
	if err == nil {
		if cancelErr := w.gateway.Cancel(ctx, credential, *job.ExternalRef); cancelErr != nil && !domain.IsProviderUnavailable(cancelErr) {
			// Cancel requests are best effort; provider-side rejection of the
			// cancel leaves polling as the authoritative convergence.
		}
	}
	// A credential resolution failure only skips the best-effort cancel
	// request; the authoritative poll below still converges the job.
	return w.drivePoll(ctx, queueID, task, job, state, media)
}

// convergeFromTerminalJob finishes a task whose job already settled but
// whose slots/aggregation did not (persist-phase crash recovery).
func (w *TaskWorker) convergeFromTerminalJob(ctx context.Context, queueID domain.UUID, task domain.GenerationTask, job domain.ProviderJob, state domain.KernelState) error {
	if job.Status == domain.JobCompleted && job.ExternalRef != nil {
		// A completed async job's outputs stay re-pollable; a persist-phase
		// crash can retry the transfer without a new external generation.
		credential, credErr := w.credentials.ActiveCallCredential(ctx)
		if credErr != nil {
			// A credential failure is transient for convergence (the same
			// policy drivePoll applies): settling the slots terminal here
			// would discard a completed job's transferable outputs as a
			// nil-reason failure outside the stable taxonomy.
			return w.reschedule(ctx, queueID, time.Now().Add(w.pollEvery), false)
		}
		if outcome, err := w.gateway.Poll(ctx, credential, *job.ExternalRef); err == nil &&
			outcome.Status == domain.PollCompleted && len(outcome.Outputs) > 0 {
			return w.transferAndPersist(ctx, queueID, task.ID, outcome.Outputs)
		}
	}
	return w.applyEvent(ctx, queueID, task.ID, state,
		domain.KernelEvent{Kind: domain.EventConvergeSettled}, time.Time{})
}

// transferAndPersist transfers provider outputs to the module's storage and
// persists the succeeded slots plus the task's terminal aggregation.
func (w *TaskWorker) transferAndPersist(ctx context.Context, queueID domain.UUID, taskID domain.UUID, outputs []domain.GatewayOutput) error {
	task, slots, job, err := w.tasks.GetForWorker(ctx, taskID)
	if err != nil {
		return err
	}
	store, storageConnection, err := w.resolveAndBindTransferStore(ctx, taskID)
	if err != nil {
		return err
	}
	writes, err := w.transferOutputs(ctx, store, task, slots, outputs)
	if err != nil {
		return err
	}
	verdict, err := domain.VerdictFor(kernelState(task, job), domain.KernelEvent{Kind: domain.EventPollCompleted})
	if err != nil {
		return err
	}
	verdict.Slots = writes
	err = w.runner.Run(ctx, func(sc domain.WriteScope) error {
		if err := w.storage.lockForUse(ctx, sc.Tx(), storageConnection); err != nil {
			return err
		}
		_, _, err := w.applier.apply(ctx, sc, domain.UUID{}, queueID, taskID, verdict)
		return err
	})
	if errors.Is(err, domain.ErrObjectStorageConnectionNotConfigured) || errors.Is(err, domain.ErrObjectStorageRevisionConflict) {
		// Keep completed writes for the deterministic retry path. Deleting
		// here could remove an exact-key object that predated this attempt.
		return domain.ErrObjectStorageUnavailable
	}
	return err
}

func (w *TaskWorker) resolveAndBindTransferStore(ctx context.Context, taskID domain.UUID) (domain.BlobStore, domain.ObjectStorageConnection, error) {
	for range 2 {
		store, connection, err := w.storage.ResolveStore(ctx)
		if err != nil {
			return nil, domain.ObjectStorageConnection{}, err
		}
		err = w.runner.Run(ctx, func(sc domain.WriteScope) error {
			if err := w.storage.lockForUse(ctx, sc.Tx(), connection); err != nil {
				return err
			}
			return w.tasks.BindObjectStorageConnection(ctx, sc.Tx(), taskID, connection.ID)
		})
		if err == nil {
			return store, connection, nil
		}
		if !errors.Is(err, domain.ErrObjectStorageConnectionNotConfigured) &&
			!errors.Is(err, domain.ErrObjectStorageRevisionConflict) {
			return nil, domain.ObjectStorageConnection{}, err
		}
	}
	return nil, domain.ObjectStorageConnection{}, domain.ErrObjectStorageUnavailable
}

// transferOutputs streams every provider output into the module's storage,
// verifies each blob through the authoritative probe, and produces slot
// writes. Outputs already exceeding the slot count are ignored (provider
// over-supply never forms results); slot shortfall marks the missing slots
// failed as temporarily unavailable so the creator can retry them.
func (w *TaskWorker) transferOutputs(ctx context.Context, store domain.BlobStore, task domain.GenerationTask, slots []domain.GenerationSlot, outputs []domain.GatewayOutput) ([]domain.SlotVerdictWrite, error) {
	writes := make([]domain.SlotVerdictWrite, 0, len(slots))
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
		result, err := w.transferOne(ctx, store, task.Spec.MediaType, task.ID, index, output)
		if err != nil {
			reason := domain.ReasonTemporarilyUnavailable
			writes = append(writes, domain.SlotVerdictWrite{
				Index: index, Status: domain.SlotFailed, Reason: &reason,
				Diagnostic: domain.FailureDiagnosticOf(err),
			})
			continue
		}
		writes = append(writes, domain.SlotVerdictWrite{Index: index, Status: domain.SlotSucceeded, Result: result})
	}
	// Remaining unsettled slots without outputs: provider shortfall.
	for _, slot := range slots {
		if slot.Status != nil || claimed[slot.Index] {
			continue
		}
		reason := domain.ReasonTemporarilyUnavailable
		writes = append(writes, domain.SlotVerdictWrite{
			Index: slot.Index, Status: domain.SlotFailed, Reason: &reason,
			Diagnostic: domain.NewFailureDiagnostic(
				domain.DiagnosticSourceProvider,
				"provider_output_missing",
				"Kapon returned fewer outputs than the requested quantity",
				nil, "", "",
			),
		})
	}
	return writes, nil
}

// transferOne streams one output into storage and probes it. A conflicting
// exact key is accepted only when both the current provider output and stored
// object have identical bounded size and SHA-256 facts. That recovers a lost
// Put response without importing an unrelated customer-owned bucket object.
func (w *TaskWorker) transferOne(ctx context.Context, store domain.BlobStore, media domain.MediaType, taskID domain.UUID, index int, output domain.GatewayOutput) (*domain.SlotResult, error) {
	blobKey := domain.GenerationResultBlobKey(taskID, index)
	// The download stream is bounded by the defensive per-output ceiling;
	// the blob store enforces the same limit on its side.
	reader, err := w.openProviderOutput(ctx, output.URL)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	put, err := store.Put(ctx, blobKey, reader, domain.GenerationResultMaxBytes)
	conflict := errors.Is(err, domain.ErrBlobConflict)
	if err != nil && !conflict {
		return nil, diagnosedFailure(
			domain.DiagnosticSourceStorage,
			"output_store_write_failed",
			"Nevix could not store the downloaded provider output",
			nil,
			err,
		)
	}
	if conflict {
		sourceSize, sourceChecksum, err := w.fingerprintProviderOutput(ctx, output)
		if err != nil {
			return nil, err
		}
		result, err := w.verifyStoredResult(ctx, store, media, blobKey, nil)
		if err != nil {
			return nil, err
		}
		if result.ByteSize != sourceSize || !bytes.Equal(result.Checksum, sourceChecksum[:]) {
			return nil, diagnosedFailure(
				domain.DiagnosticSourceStorage,
				"output_store_conflict",
				"Nevix could not safely resume the provider output transfer",
				nil,
				domain.ErrBlobConflict,
			)
		}
		return result, nil
	}
	result, err := w.verifyStoredResult(ctx, store, media, blobKey, &put)
	if err != nil {
		_ = store.Delete(ctx, blobKey)
		return nil, err
	}
	return result, nil
}

func (w *TaskWorker) fingerprintProviderOutput(ctx context.Context, output domain.GatewayOutput) (int64, [sha256.Size]byte, error) {
	reader, err := w.openProviderOutput(ctx, output.URL)
	if err != nil {
		return 0, [sha256.Size]byte{}, err
	}
	defer reader.Close()
	digest := sha256.New()
	size, err := io.Copy(digest, io.LimitReader(reader, domain.GenerationResultMaxBytes+1))
	if err != nil {
		return 0, [sha256.Size]byte{}, diagnosedFailure(
			domain.DiagnosticSourceProvider,
			"provider_output_read_failed",
			"Nevix could not reread the provider output for safe transfer recovery",
			nil,
			err,
		)
	}
	if size > domain.GenerationResultMaxBytes {
		return 0, [sha256.Size]byte{}, diagnosedFailure(
			domain.DiagnosticSourceProvider,
			"provider_output_too_large",
			"The provider output exceeds the supported size",
			nil,
			domain.ErrTooLarge,
		)
	}
	var checksum [sha256.Size]byte
	copy(checksum[:], digest.Sum(nil))
	return size, checksum, nil
}

func (w *TaskWorker) verifyStoredResult(ctx context.Context, store domain.BlobStore, media domain.MediaType, blobKey string, completedWrite *domain.PutResult) (*domain.SlotResult, error) {
	stored, size, err := store.Open(ctx, blobKey, domain.FullBlobRange)
	if err != nil {
		return nil, diagnosedFailure(
			domain.DiagnosticSourceStorage,
			"output_store_read_failed",
			"Nevix could not reopen the stored provider output for verification",
			nil,
			err,
		)
	}
	defer stored.Close()
	if size < 0 || size > domain.GenerationResultMaxBytes {
		return nil, diagnosedFailure(
			domain.DiagnosticSourceStorage,
			"output_store_verification_failed",
			"Nevix could not verify the stored provider output",
			nil,
			domain.ErrTooLarge,
		)
	}
	identified, err := w.prober.Identify(stored)
	if err != nil {
		return nil, diagnosedFailure(
			domain.DiagnosticSourceMediaProbe,
			"output_probe_failed",
			"Nevix could not identify the downloaded provider output",
			nil,
			err,
		)
	}
	if !domain.OutputMimeAccepted(media, identified.Facts.MimeType) {
		return nil, diagnosedFailure(
			domain.DiagnosticSourceMediaProbe,
			"output_mime_mismatch",
			fmt.Sprintf("Provider output MIME type %q is not accepted for %s generation", identified.Facts.MimeType, media),
			nil,
			errors.New("creation: provider output failed output verification"),
		)
	}
	checksum := []byte(nil)
	if completedWrite != nil {
		if completedWrite.ByteSize != size {
			return nil, diagnosedFailure(
				domain.DiagnosticSourceStorage,
				"output_store_verification_failed",
				"Nevix could not verify the stored provider output",
				nil,
				errors.New("creation: stored provider output differs from the completed write"),
			)
		}
		checksum = append(checksum, completedWrite.SHA256Sum[:]...)
	} else {
		if _, err := stored.Seek(0, io.SeekStart); err != nil {
			return nil, diagnosedFailure(
				domain.DiagnosticSourceStorage,
				"output_store_read_failed",
				"Nevix could not reopen the stored provider output for verification",
				nil,
				err,
			)
		}
		digest := sha256.New()
		read, err := io.Copy(digest, io.LimitReader(stored, domain.GenerationResultMaxBytes+1))
		if err != nil || read != size {
			if err == nil {
				err = errors.New("creation: stored provider output length changed during verification")
			}
			return nil, diagnosedFailure(
				domain.DiagnosticSourceStorage,
				"output_store_read_failed",
				"Nevix could not read the stored provider output for verification",
				nil,
				err,
			)
		}
		checksum = digest.Sum(nil)
	}
	return &domain.SlotResult{
		Mime:       identified.Facts.MimeType,
		ByteSize:   size,
		Checksum:   checksum,
		BlobKey:    blobKey,
		WidthPx:    identified.Facts.WidthPx,
		HeightPx:   identified.Facts.HeightPx,
		DurationMS: identified.Facts.DurationMS,
	}, nil
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
// store's bounded copy loop; the URL never reaches logs or responses. The
// transport error is deliberately unwrapped: *url.Error embeds the URL, so
// only its class survives to the worker's failure log.
func (w *TaskWorker) openProviderOutput(ctx context.Context, url string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, diagnosedFailure(
			domain.DiagnosticSourceOutputTransfer,
			"provider_output_url_invalid",
			"Kapon returned an invalid output URL",
			nil,
			errors.New("creation: build provider output request"),
		)
	}
	resp, err := w.fetch.Do(req)
	if err != nil {
		if errors.Is(err, context.Canceled) || ctx.Err() != nil {
			return nil, diagnosedFailure(
				domain.DiagnosticSourceOutputTransfer,
				"provider_output_fetch_cancelled",
				"Provider output download was cancelled before completion",
				nil,
				errors.New("creation: fetch provider output canceled"),
			)
		}
		return nil, diagnosedFailure(
			domain.DiagnosticSourceOutputTransfer,
			"provider_output_fetch_failed",
			"Provider output download failed before an HTTP response was received",
			nil,
			errors.New("creation: fetch provider output failed"),
		)
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		status := resp.StatusCode
		return nil, diagnosedFailure(
			domain.DiagnosticSourceOutputTransfer,
			"provider_output_http_status",
			fmt.Sprintf("Provider output download returned HTTP %d", status),
			&status,
			fmt.Errorf("creation: provider output fetch returned %d", status),
		)
	}
	return resp.Body, nil
}

func diagnosedFailure(source domain.FailureDiagnosticSource, code, message string, httpStatus *int, err error) error {
	return domain.WithFailureDiagnostic(
		err,
		domain.NewFailureDiagnostic(source, code, message, httpStatus, "", ""),
	)
}

func strPtr(value string) *string { return &value }

func failureReasonPtr(reason domain.FailureReason) *domain.FailureReason { return &reason }
