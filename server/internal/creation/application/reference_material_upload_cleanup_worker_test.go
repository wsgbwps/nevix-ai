package application

import (
	"context"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

type cancelCleanupRunner struct {
	calls  int
	cancel context.CancelFunc
}

func (r *cancelCleanupRunner) Run(context.Context, func(domain.WriteScope) error) error {
	r.calls++
	if r.cancel != nil {
		r.cancel()
	}
	return context.Canceled
}

func TestReferenceMaterialCleanupBackoff(t *testing.T) {
	wants := map[int]time.Duration{
		1:  time.Minute,
		2:  2 * time.Minute,
		7:  time.Hour,
		20: time.Hour,
	}
	for attempt, want := range wants {
		if got := referenceMaterialCleanupBackoff(attempt); got != want {
			t.Fatalf("attempt %d backoff = %s, want %s", attempt, got, want)
		}
	}
}

func TestReferenceMaterialCleanupWorkerTreatsShutdownAsSuccess(t *testing.T) {
	t.Run("before claim", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		runner := &cancelCleanupRunner{}
		worker := &ReferenceMaterialUploadCleanupWorker{runner: runner, now: time.Now}

		if err := worker.Run(ctx); err != nil {
			t.Fatalf("run canceled worker: %v", err)
		}
		if runner.calls != 0 {
			t.Fatalf("claim calls = %d, want 0", runner.calls)
		}
	})

	t.Run("during claim", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		runner := &cancelCleanupRunner{cancel: cancel}
		worker := &ReferenceMaterialUploadCleanupWorker{runner: runner, now: time.Now}

		if err := worker.Run(ctx); err != nil {
			t.Fatalf("run canceled worker: %v", err)
		}
		if runner.calls != 1 {
			t.Fatalf("claim calls = %d, want 1", runner.calls)
		}
	})
}
