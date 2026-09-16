package application

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

type cancelDuringClaimRepository struct {
	domain.GenerationTaskRepository
	started    chan<- struct{}
	claimError func(context.Context) error
}

func (r cancelDuringClaimRepository) ClaimNextQueueItem(ctx context.Context, _ string, _ time.Duration) (domain.ClaimedQueueItem, bool, error) {
	close(r.started)
	<-ctx.Done()
	return domain.ClaimedQueueItem{}, false, r.claimError(ctx)
}

func TestTaskWorkerRunStopsCleanlyWhenClaimIsCancelled(t *testing.T) {
	started := make(chan struct{})
	worker := &TaskWorker{tasks: cancelDuringClaimRepository{
		started: started,
		claimError: func(ctx context.Context) error {
			return fmt.Errorf("creation: claim queue item: %w", ctx.Err())
		},
	}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- worker.Run(ctx) }()
	<-started
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("cancel worker during claim: %v", err)
	}
}

func TestTaskWorkerRunDoesNotHideClaimFailureAfterCancellation(t *testing.T) {
	started := make(chan struct{})
	want := errors.New("database unavailable")
	worker := &TaskWorker{tasks: cancelDuringClaimRepository{
		started:    started,
		claimError: func(context.Context) error { return want },
	}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- worker.Run(ctx) }()
	<-started
	cancel()
	if err := <-done; !errors.Is(err, want) {
		t.Fatalf("claim failure after cancellation = %v, want %v", err, want)
	}
}
