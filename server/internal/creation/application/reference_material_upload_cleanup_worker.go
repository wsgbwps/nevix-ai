package application

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

const (
	referenceMaterialCleanupBatchSize   = 100
	referenceMaterialCleanupConcurrency = 8
	referenceMaterialCleanupTimeout     = 30 * time.Second
)

// ReferenceMaterialUploadCleanupWorker converges expired, ineligible, and
// already-terminal upload authorities.
type ReferenceMaterialUploadCleanupWorker struct {
	uploads   domain.ReferenceMaterialUploadRepository
	materials domain.MaterialRepository
	storage   *ObjectStorageConnectionService
	runner    domain.WriteRunner
	now       func() time.Time
	pollEvery time.Duration
}

func NewReferenceMaterialUploadCleanupWorker(
	uploads domain.ReferenceMaterialUploadRepository,
	materials domain.MaterialRepository,
	storage *ObjectStorageConnectionService,
	runner domain.WriteRunner,
	now func() time.Time,
) *ReferenceMaterialUploadCleanupWorker {
	if now == nil {
		now = time.Now
	}
	return &ReferenceMaterialUploadCleanupWorker{
		uploads:   uploads,
		materials: materials,
		storage:   storage,
		runner:    runner,
		now:       now,
		pollEvery: time.Minute,
	}
}

func (w *ReferenceMaterialUploadCleanupWorker) Run(ctx context.Context) error {
	for {
		if ctx.Err() != nil {
			return nil
		}
		if err := w.runOnce(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(w.pollEvery):
		}
	}
}

func (w *ReferenceMaterialUploadCleanupWorker) runOnce(ctx context.Context) error {
	now := w.now().UTC()
	if err := w.runner.Run(ctx, func(scope domain.WriteScope) error {
		return w.uploads.TerminalizeExpiredOrInvalid(ctx, scope.Tx(), now, referenceMaterialCleanupBatchSize)
	}); err != nil {
		return err
	}
	store, _, err := w.storage.ResolveStore(ctx)
	if err != nil {
		return nil
	}
	now = w.now().UTC()
	claims := make([]domain.ReferenceMaterialUploadCleanup, 0, referenceMaterialCleanupBatchSize)
	if err := w.runner.Run(ctx, func(scope domain.WriteScope) error {
		due, err := w.uploads.LockDueCleanups(ctx, scope.Tx(), now, referenceMaterialCleanupBatchSize)
		if err != nil {
			return err
		}
		for _, upload := range due {
			next := now.Add(referenceMaterialCleanupBackoff(upload.CleanupAttemptCount + 1))
			if now.Before(upload.FinalizeDeadline) && next.After(upload.FinalizeDeadline) {
				next = upload.FinalizeDeadline
			}
			claim, err := w.uploads.MarkCleanupAttempt(ctx, scope.Tx(), upload.ID, next)
			if err != nil {
				return err
			}
			claims = append(claims, claim)
		}
		return nil
	}); err != nil {
		return err
	}
	if len(claims) == 0 {
		return nil
	}
	var wait sync.WaitGroup
	parallel := make(chan struct{}, referenceMaterialCleanupConcurrency)
	for _, claim := range claims {
		select {
		case parallel <- struct{}{}:
		case <-ctx.Done():
			wait.Wait()
			return nil
		}
		claim := claim
		wait.Add(1)
		go func() {
			defer wait.Done()
			defer func() { <-parallel }()
			w.cleanClaim(ctx, store, claim)
		}()
	}
	wait.Wait()
	return nil
}

func (w *ReferenceMaterialUploadCleanupWorker) cleanClaim(ctx context.Context, store domain.ObjectStorageBlobStore, claim domain.ReferenceMaterialUploadCleanup) {
	deleteCtx, cancel := context.WithTimeout(ctx, referenceMaterialCleanupTimeout)
	defer cancel()
	if err := w.materials.WithObjectLock(deleteCtx, claim.ObjectKey, func() error {
		eligible := false
		if err := w.runner.Run(deleteCtx, func(scope domain.WriteScope) error {
			current, err := w.uploads.LockCleanupClaim(deleteCtx, scope.Tx(), claim.UploadID, claim.Attempt)
			if err != nil || !current {
				return err
			}
			retained, err := w.uploads.ObjectRetained(deleteCtx, scope.Tx(), claim.ObjectKey)
			eligible = !retained
			return err
		}); err != nil || !eligible {
			return err
		}
		if err := store.Delete(deleteCtx, claim.ObjectKey); err != nil {
			return err
		}
		confirmedAt := w.now().UTC()
		if confirmedAt.Before(claim.FinalizeDeadline) {
			return nil
		}
		return w.runner.Run(deleteCtx, func(scope domain.WriteScope) error {
			return w.uploads.MarkCleanupConfirmed(deleteCtx, scope.Tx(), claim.UploadID, claim.Attempt, confirmedAt)
		})
	}); err != nil {
		slog.Warn(OrphanBlobLogWarning, "code", "cleanup_failed")
	}
}

func referenceMaterialCleanupBackoff(attempt int) time.Duration {
	if attempt <= 1 {
		return time.Minute
	}
	if attempt >= 7 {
		return time.Hour
	}
	return time.Minute * time.Duration(1<<(attempt-1))
}
