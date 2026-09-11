package application

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// verdictApplier is the single verdict application routine (ADR-0019): the
// only code path that calls the repository's guarded transition writes. It
// receives write-set data only — every CAS from-set is built from state
// re-read inside the caller's verified transaction. Convergence write order:
// job edge → settle slots → aggregate → release → retire → notify.
// Lost-race semantics: a non-terminal advancement losing its CAS is
// tolerated (the next pass re-reads and re-routes); a terminal convergence
// losing its CAS is an error the next process() pass self-heals through the
// terminal-park branch.
type verdictApplier struct {
	tasks       domain.GenerationTaskRepository
	connections domain.ConnectionSignals
	assets      domain.MediaAssetRepository // worker-only: output transfer forms assets
	notify      InvalidationSink
	gateway     domain.ProviderGateway // worker-only: terminal commits release prepared references
}

// apply runs one verdict's write-set inside the caller's verified
// transaction. It reports the durable submit-attempt count licensed by a
// VerdictSubmitMarker and whether the marker won (false means a cancel
// converged first: nothing external may run, and the caller must stand
// down); every other verdict always reports true.
func (a verdictApplier) apply(ctx context.Context, sc domain.WriteScope, owner, queueID, taskID domain.UUID, verdict domain.KernelVerdict) (int, bool, error) {
	switch verdict.Kind {
	case domain.VerdictSubmitMarker:
		return a.applySubmitMarker(ctx, sc, taskID, verdict)
	case domain.VerdictRefBound:
		return 0, true, a.applyRefBound(ctx, sc, queueID, taskID, verdict)
	case domain.VerdictPromoted, domain.VerdictCancelMarked:
		return 0, true, a.applyAdvance(ctx, sc, queueID, taskID, verdict)
	case domain.VerdictTransferred:
		return 0, true, a.applyTransferred(ctx, sc, queueID, taskID, verdict)
	case domain.VerdictTerminal:
		return 0, true, a.applyTerminal(ctx, sc, owner, queueID, taskID, verdict)
	}
	return 0, false, fmt.Errorf("creation: unknown kernel verdict %q", verdict.Kind)
}

// applySubmitMarker commits the crash-recovery marker and licenses exactly
// one external submit. The task edge is an optional table-guarded edge that
// aborts silently because nothing external has executed yet.
func (a verdictApplier) applySubmitMarker(ctx context.Context, sc domain.WriteScope, taskID domain.UUID, verdict domain.KernelVerdict) (int, bool, error) {
	freshTask, _, freshJob, err := a.tasks.GetForOwnerInTx(ctx, sc.Tx(), domain.UUID{}, taskID)
	if err != nil {
		return 0, false, err
	}
	if freshTask.Status != verdict.TaskTo {
		if !domain.TaskCanTransition(freshTask.Status, verdict.TaskTo) {
			return 0, false, nil
		}
		ok, err := a.tasks.TransitionTask(ctx, sc.Tx(), taskID,
			[]domain.TaskStatus{freshTask.Status}, verdict.TaskTo, nil)
		if err != nil {
			return 0, false, err
		}
		if !ok {
			return 0, false, nil
		}
	}
	attempts, ok, err := a.tasks.BeginJobSubmitAttempt(ctx, sc.Tx(), freshJob.ID,
		[]domain.JobStatus{freshJob.Status})
	if err != nil {
		return 0, false, err
	}
	if !ok {
		// A partial marker would make the next pass misclassify an unstarted
		// call as indeterminate: roll the whole marker back.
		return 0, false, errors.New("creation: provider job submit marker lost")
	}
	return attempts, true, nil
}

// applyRefBound lands an async submit acceptance: the external identity is
// bound as an optional self-loop write (the transition table holds no
// self-loop edge), then the item parks for its first poll.
func (a verdictApplier) applyRefBound(ctx context.Context, sc domain.WriteScope, queueID, taskID domain.UUID, verdict domain.KernelVerdict) error {
	freshTask, _, freshJob, err := a.tasks.GetForOwnerInTx(ctx, sc.Tx(), domain.UUID{}, taskID)
	if err != nil {
		return err
	}
	if freshJob.Status == verdict.JobTo && freshJob.ExternalRef == nil {
		if _, err := a.tasks.TransitionJob(ctx, sc.Tx(), freshJob.ID,
			[]domain.JobStatus{freshJob.Status}, verdict.JobTo, verdict.ExternalRef); err != nil {
			return err
		}
	}
	if err := a.tasks.ReleaseQueueItem(ctx, sc.Tx(), queueID, verdict.RunAfter); err != nil {
		return err
	}
	a.notifyOwner(sc, freshTask.OwnerID)
	return nil
}

// applyAdvance lands a non-terminal edge pair (first-poll promotion or the
// recorded cancel intent). Both edges are optional and table-guarded: an
// already-applied target skips.
func (a verdictApplier) applyAdvance(ctx context.Context, sc domain.WriteScope, queueID, taskID domain.UUID, verdict domain.KernelVerdict) error {
	freshTask, _, freshJob, err := a.tasks.GetForOwnerInTx(ctx, sc.Tx(), domain.UUID{}, taskID)
	if err != nil {
		return err
	}
	if freshJob.Status != verdict.JobTo && domain.JobCanTransition(freshJob.Status, verdict.JobTo) {
		if _, err := a.tasks.TransitionJob(ctx, sc.Tx(), freshJob.ID,
			[]domain.JobStatus{freshJob.Status}, verdict.JobTo, nil); err != nil {
			return err
		}
	}
	if freshTask.Status != verdict.TaskTo && domain.TaskCanTransition(freshTask.Status, verdict.TaskTo) {
		if _, err := a.tasks.TransitionTask(ctx, sc.Tx(), freshTask.ID,
			[]domain.TaskStatus{freshTask.Status}, verdict.TaskTo, nil); err != nil {
			return err
		}
	}
	if err := a.tasks.ReleaseQueueItem(ctx, sc.Tx(), queueID, verdict.RunAfter); err != nil {
		return err
	}
	a.notifyOwner(sc, freshTask.OwnerID)
	return nil
}

// landJobEdge applies the strict terminal-verdict job edge: already
// terminal as another verdict is a lost convergence, reported as an error.
func (a verdictApplier) landJobEdge(ctx context.Context, sc domain.WriteScope, freshJob domain.ProviderJob, to domain.JobStatus) (bool, error) {
	if domain.JobIsTerminal(freshJob.Status) {
		if freshJob.Status != to {
			return false, fmt.Errorf("creation: provider job already terminal as %s", freshJob.Status)
		}
		return false, nil
	}
	ok, err := a.tasks.TransitionJob(ctx, sc.Tx(), freshJob.ID,
		[]domain.JobStatus{freshJob.Status}, to, nil)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, errors.New("creation: provider job terminal transition lost")
	}
	return true, nil
}

// applyTransferred lands transferred, verified outputs: write-once slot
// results and Media Asset formations, then the unified convergence tail.
func (a verdictApplier) applyTransferred(ctx context.Context, sc domain.WriteScope, queueID, taskID domain.UUID, verdict domain.KernelVerdict) error {
	freshTask, _, freshJob, err := a.tasks.GetForOwnerInTx(ctx, sc.Tx(), domain.UUID{}, taskID)
	if err != nil {
		return err
	}
	landed, err := a.landJobEdge(ctx, sc, freshJob, verdict.JobTo)
	if err != nil {
		return err
	}
	// Optional table-guarded edge; a cancelling task keeps its status and the
	// aggregation below lands the table's own cancelling→succeeded edge.
	if freshTask.Status != verdict.TaskTo && domain.TaskCanTransition(freshTask.Status, verdict.TaskTo) {
		if _, err := a.tasks.TransitionTask(ctx, sc.Tx(), freshTask.ID,
			[]domain.TaskStatus{freshTask.Status}, verdict.TaskTo, nil); err != nil {
			return err
		}
	}
	for _, write := range verdict.Slots {
		if _, err := a.tasks.WriteSlotVerdict(ctx, sc.Tx(), freshTask.ID, write.Index, write.Status, write.Reason, write.Diagnostic, write.Result); err != nil {
			return err
		}
		// The verified output becomes the slot's unique Media Asset in the
		// same transaction; a repeated convergence lands on the (task, slot)
		// unique constraint and must not duplicate it.
		if write.Status == domain.SlotSucceeded && write.Result != nil && a.assets != nil {
			if _, err := a.assets.InsertMediaAsset(ctx, sc.Tx(), domain.MediaAssetFormation{
				OwnerID:    freshTask.OwnerID,
				TaskID:     freshTask.ID,
				SlotIndex:  write.Index,
				MediaType:  freshTask.Spec.MediaType,
				Mime:       write.Result.Mime,
				BlobKey:    write.Result.BlobKey,
				ByteSize:   write.Result.ByteSize,
				Checksum:   write.Result.Checksum,
				WidthPx:    write.Result.WidthPx,
				HeightPx:   write.Result.HeightPx,
				DurationMS: write.Result.DurationMS,
			}); err != nil {
				return err
			}
		}
	}
	if err := a.aggregateAndFinalize(ctx, sc.Tx(), freshTask.ID); err != nil {
		return err
	}
	if _, err := a.tasks.ReleaseReservation(ctx, sc.Tx(), freshTask.ID); err != nil {
		return err
	}
	if err := a.tasks.RetireQueueItem(ctx, sc.Tx(), queueID); err != nil {
		return err
	}
	a.notifyOwner(sc, freshTask.OwnerID)
	if landed {
		a.releaseProviderTransfersAfterCommit(sc, freshJob.ID, verdict.JobTo, len(freshTask.Spec.References))
	}
	return nil
}

// applyTerminal lands one terminal job verdict with the unified convergence
// write order. The optional TaskGuard/TaskTo pair serves the creator's
// immediate cancel: the
// convergence only proceeds while the claimed task status still holds, and
// losing that claim aborts silently — the worker reconciles from the intent
// marker.
func (a verdictApplier) applyTerminal(ctx context.Context, sc domain.WriteScope, owner, queueID, taskID domain.UUID, verdict domain.KernelVerdict) error {
	if verdict.CreditBlocked {
		if err := a.connections.MarkCreditBlocked(ctx, sc.Tx()); err != nil {
			return err
		}
	}
	freshTask, _, freshJob, err := a.tasks.GetForOwnerInTx(ctx, sc.Tx(), owner, taskID)
	if err != nil {
		return err
	}
	if verdict.TaskTo != "" && !domain.TaskIsTerminal(freshTask.Status) {
		if verdict.TaskGuard != "" && freshTask.Status != verdict.TaskGuard {
			return nil
		}
		ok, err := a.tasks.TransitionTask(ctx, sc.Tx(), taskID,
			[]domain.TaskStatus{freshTask.Status}, verdict.TaskTo, nil)
		if err != nil {
			return err
		}
		if !ok {
			return nil
		}
	}
	landed, err := a.landJobEdge(ctx, sc, freshJob, verdict.JobTo)
	if err != nil {
		return err
	}
	slotStatus, slotReason := domain.SlotVerdictForJob(verdict.JobTo, verdict.Reason)
	if err := a.settleUnsettledSlots(ctx, sc.Tx(), taskID, slotStatus, slotReason, verdict.Diagnostic); err != nil {
		return err
	}
	if err := a.aggregateAndFinalize(ctx, sc.Tx(), taskID); err != nil {
		return err
	}
	if _, err := a.tasks.ReleaseReservation(ctx, sc.Tx(), taskID); err != nil {
		return err
	}
	if err := a.tasks.RetireQueueItem(ctx, sc.Tx(), queueID); err != nil {
		return err
	}
	a.notifyOwner(sc, freshTask.OwnerID)
	if landed {
		a.releaseProviderTransfersAfterCommit(sc, freshJob.ID, verdict.JobTo, len(freshTask.Spec.References))
	}
	return nil
}

func (a verdictApplier) settleUnsettledSlots(ctx context.Context, tx domain.TxExecutor, taskID domain.UUID, status domain.SlotStatus, reason *domain.FailureReason, diagnostic *domain.FailureDiagnostic) error {
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
		if _, err := a.tasks.WriteSlotVerdict(ctx, tx, taskID, index, status, reason, diagnostic, nil); err != nil {
			return err
		}
	}
	return nil
}

// aggregateAndFinalize computes the task's terminal verdict once every slot
// has one and performs the guarded terminal transition. The reservation is
// released by the caller in the same transaction after a winning transition.
func (a verdictApplier) aggregateAndFinalize(ctx context.Context, tx domain.TxExecutor, taskID domain.UUID) error {
	task, slots, _, err := a.tasks.GetForOwnerInTx(ctx, tx, domain.UUID{}, taskID)
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
			return nil
		}
		outcomes = append(outcomes, domain.SlotOutcome{Index: slot.Index, Status: *slot.Status})
	}
	status, cause, ok := domain.AggregateTaskStatus(task.SlotCount, outcomes)
	if !ok {
		return nil
	}
	_, err = a.tasks.TransitionTask(ctx, tx, task.ID,
		[]domain.TaskStatus{task.Status}, status, cause)
	return err
}

func (a verdictApplier) notifyOwner(sc domain.WriteScope, owner domain.UUID) {
	if a.notify == nil {
		return
	}
	sc.AfterCommit(func() { a.notify.NotifyGenerationChanged(owner) })
}

func (a verdictApplier) releaseProviderTransfersAfterCommit(sc domain.WriteScope, jobID domain.UUID, status domain.JobStatus, referenceCount int) {
	if a.gateway == nil || !providerTransferCleanupEligible(status) || referenceCount == 0 {
		return
	}
	sc.AfterCommit(func() { releaseProviderTransfers(a.gateway, jobID, status, referenceCount) })
}

const providerTransferCleanupTimeout = 30 * time.Second

func providerTransferCleanupEligible(status domain.JobStatus) bool {
	switch status {
	case domain.JobCompleted, domain.JobFailed, domain.JobCancelled, domain.JobTimedOut:
		return true
	default:
		return false
	}
}

func releaseProviderTransfers(gateway domain.ProviderGateway, jobID domain.UUID, status domain.JobStatus, referenceCount int) {
	failedCount := 0
	for ordinal := range referenceCount {
		if !releaseProviderTransfer(gateway, jobID, ordinal) {
			failedCount++
		}
	}
	if failedCount > 0 {
		slog.Warn("creation: provider transfer cleanup incomplete",
			"job_status", status,
			"reference_count", referenceCount,
			"failed_count", failedCount,
		)
	}
}

func releaseProviderTransfer(gateway domain.ProviderGateway, jobID domain.UUID, ordinal int) (released bool) {
	released = false
	defer func() { _ = recover() }()
	ctx, cancel := context.WithTimeout(context.Background(), providerTransferCleanupTimeout)
	defer cancel()
	return gateway.ReleaseReference(ctx, jobID, ordinal) == nil
}
