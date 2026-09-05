package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
	"github.com/nevix-ai/server/internal/creation/infrastructure/writetx"
	"github.com/nevix-ai/server/internal/migration"
)

func TestGenerationTaskDetailUsesOneSnapshot(t *testing.T) {
	ownerURL, runtimeURL := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner pool: %v", err)
	}
	defer owner.Close()

	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect identity_app pool: %v", err)
	}
	defer runtime.Close()

	creator := fixtureUser(t, ownerURL)
	sessionID := fixtureSession(t, ownerURL, owner, creator)
	taskID := fixtureGenerationTask(t, ownerURL, owner, creator, sessionID)
	if _, err := owner.Exec(ctx,
		`INSERT INTO creation_generation_slots (task_id, slot_index) VALUES ($1, 0)`, taskID); err != nil {
		t.Fatalf("seed generation slot: %v", err)
	}

	repo := NewGenerationTaskRepository(runtime)
	writerCtx, stopWriter := context.WithCancel(ctx)
	defer stopWriter()
	writerStarted := make(chan struct{})
	writerDone := make(chan error, 1)
	go func() {
		failed := true
		started := false
		for {
			writer, err := owner.Begin(writerCtx)
			if err != nil {
				if errors.Is(err, context.Canceled) {
					writerDone <- nil
				} else {
					writerDone <- err
				}
				return
			}
			if _, err = writer.Exec(writerCtx, `
				UPDATE creation_generation_tasks
				SET status = CASE WHEN $2 THEN 'failed' ELSE 'queued' END,
				    terminal_at = CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,
				    updated_at = clock_timestamp()
				WHERE id = $1`, taskID, failed); err == nil {
				_, err = writer.Exec(writerCtx, `
					UPDATE creation_generation_slots
					SET status = CASE WHEN $2 THEN 'failed' ELSE NULL END,
					    failure_reason = CASE WHEN $2 THEN 'internal_error' ELSE NULL END
					WHERE task_id = $1 AND slot_index = 0`, taskID, failed)
			}
			if err == nil {
				err = writer.Commit(writerCtx)
			} else {
				_ = writer.Rollback(context.Background())
			}
			if err != nil {
				if errors.Is(err, context.Canceled) {
					writerDone <- nil
				} else {
					writerDone <- err
				}
				return
			}
			if !started {
				close(writerStarted)
				started = true
			}
			failed = !failed
		}
	}()

	select {
	case <-writerStarted:
	case err := <-writerDone:
		t.Fatalf("start concurrent detail writer: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("concurrent detail writer did not start")
	}

	observedQueued, observedFailed := false, false
	for range 250 {
		task, slots, err := repo.GetForOwner(ctx, creator, taskID)
		if err != nil {
			t.Fatalf("read task detail during concurrent changes: %v", err)
		}
		if len(slots) != 1 {
			t.Fatalf("detail returned %d slots, want 1", len(slots))
		}
		switch task.Status {
		case domain.TaskQueued:
			observedQueued = true
			if slots[0].Status != nil {
				t.Fatalf("detail mixed queued task with committed slot verdict: %+v", slots[0])
			}
		case domain.TaskFailed:
			observedFailed = true
			if slots[0].Status == nil || *slots[0].Status != domain.SlotFailed {
				t.Fatalf("detail mixed failed task with uncommitted slot verdict: %+v", slots[0])
			}
		default:
			t.Fatalf("detail returned unexpected task status %q", task.Status)
		}
	}
	stopWriter()
	select {
	case err := <-writerDone:
		if err != nil {
			t.Fatalf("run concurrent detail writer: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("concurrent detail writer did not stop")
	}
	if !observedQueued || !observedFailed {
		t.Fatalf("concurrent read did not observe both complete snapshots: queued=%t failed=%t", observedQueued, observedFailed)
	}
}

func TestGenerationTaskUpdatedAtTracksEveryVisibleDetailChange(t *testing.T) {
	ownerURL, runtimeURL := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner pool: %v", err)
	}
	defer owner.Close()
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect identity_app pool: %v", err)
	}
	defer runtime.Close()

	creator := fixtureUser(t, ownerURL)
	sessionID := fixtureSession(t, ownerURL, owner, creator)
	taskID := fixtureGenerationTask(t, ownerURL, owner, creator, sessionID)
	baseline := time.Date(2099, time.January, 2, 3, 4, 5, 123456000, time.UTC)
	if _, err := owner.Exec(ctx,
		`UPDATE creation_generation_tasks SET slot_count = 3, updated_at = $2 WHERE id = $1`, taskID, baseline); err != nil {
		t.Fatalf("seed future marker: %v", err)
	}
	if _, err := owner.Exec(ctx,
		`INSERT INTO creation_generation_slots (task_id, slot_index) VALUES ($1, 0), ($1, 1), ($1, 2)`, taskID); err != nil {
		t.Fatalf("seed generation slots: %v", err)
	}

	repo := NewGenerationTaskRepository(runtime)
	runner := writetx.New(runtime)
	marker := baseline
	assertAdvanced := func(change string) (domain.GenerationTask, []domain.GenerationSlot) {
		t.Helper()
		task, slots, err := repo.GetForOwner(ctx, creator, taskID)
		if err != nil {
			t.Fatalf("%s: read detail: %v", change, err)
		}
		if !task.UpdatedAt.After(marker) {
			t.Fatalf("%s: updated_at did not advance: before=%s after=%s", change, marker, task.UpdatedAt)
		}
		summaries, _, err := repo.ListBySession(ctx, creator, sessionID, nil, 10)
		if err != nil {
			t.Fatalf("%s: list tasks: %v", change, err)
		}
		if len(summaries) != 1 || !summaries[0].UpdatedAt.Equal(task.UpdatedAt) || summaries[0].Status != task.Status || summaries[0].CancelRequested != task.CancelRequested {
			t.Fatalf("%s: list/detail task facts differ: list=%+v detail=%+v", change, summaries, task)
		}
		marker = task.UpdatedAt
		return task, slots
	}

	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		changed, err := repo.TransitionTask(ctx, sc.Tx(), taskID, []domain.TaskStatus{domain.TaskQueued}, domain.TaskSubmitting, nil)
		if err == nil && !changed {
			t.Fatal("task transition was unexpectedly rejected")
		}
		return err
	}); err != nil {
		t.Fatalf("transition task: %v", err)
	}
	assertAdvanced("task status")

	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		_, found, err := repo.RequestCancel(ctx, sc.Tx(), creator, taskID)
		if err == nil && !found {
			t.Fatal("task cancel target was unexpectedly absent")
		}
		return err
	}); err != nil {
		t.Fatalf("request cancel: %v", err)
	}
	cancelled, _ := assertAdvanced("cancel request")
	if !cancelled.CancelRequested {
		t.Fatal("cancel request was not visible in detail")
	}
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		_, _, err := repo.RequestCancel(ctx, sc.Tx(), creator, taskID)
		return err
	}); err != nil {
		t.Fatalf("repeat cancel: %v", err)
	}
	afterRepeatCancel, _, err := repo.GetForOwner(ctx, creator, taskID)
	if err != nil {
		t.Fatalf("read repeated cancel: %v", err)
	}
	if !afterRepeatCancel.UpdatedAt.Equal(marker) {
		t.Fatalf("idempotent cancel changed the detail criterion: before=%s after=%s", marker, afterRepeatCancel.UpdatedAt)
	}

	reason := domain.ReasonInternalError
	diagnostic := domain.NewFailureDiagnostic(domain.DiagnosticSourceStorage, "store_failed", "safe failure", nil, "", "")
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		changed, err := repo.WriteSlotVerdict(ctx, sc.Tx(), taskID, 0, domain.SlotFailed, &reason, diagnostic, nil)
		if err == nil && !changed {
			t.Fatal("first slot verdict was unexpectedly rejected")
		}
		return err
	}); err != nil {
		t.Fatalf("write failed slot: %v", err)
	}
	_, slots := assertAdvanced("slot diagnostic")
	if slots[0].Diagnostic == nil || slots[0].Diagnostic.Code != "store_failed" {
		t.Fatalf("slot diagnostic was not visible: %+v", slots[0])
	}
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		changed, err := repo.WriteSlotVerdict(ctx, sc.Tx(), taskID, 0, domain.SlotFailed, &reason, diagnostic, nil)
		if err == nil && changed {
			return errors.New("repeated slot verdict unexpectedly changed")
		}
		return err
	}); err != nil {
		t.Fatalf("repeat slot verdict: %v", err)
	}
	afterRepeatVerdict, _, err := repo.GetForOwner(ctx, creator, taskID)
	if err != nil {
		t.Fatalf("read repeated slot verdict: %v", err)
	}
	if !afterRepeatVerdict.UpdatedAt.Equal(marker) {
		t.Fatalf("write-once slot replay changed the detail criterion: before=%s after=%s", marker, afterRepeatVerdict.UpdatedAt)
	}

	width, height := 1024, 768
	result := &domain.SlotResult{
		Mime:     "image/png",
		ByteSize: 256,
		Checksum: []byte("0123456789abcdef0123456789abcdef"),
		BlobKey:  "generation-results/fixture/slot-1",
		WidthPx:  &width,
		HeightPx: &height,
	}
	beforeConcurrentWrites := marker
	start := make(chan struct{})
	writeResults := make(chan error, 2)
	go func() {
		<-start
		writeResults <- runner.Run(ctx, func(sc domain.WriteScope) error {
			changed, err := repo.WriteSlotVerdict(ctx, sc.Tx(), taskID, 1, domain.SlotSucceeded, nil, nil, result)
			if err == nil && !changed {
				return errors.New("succeeded slot verdict was unexpectedly rejected")
			}
			return err
		})
	}()
	go func() {
		<-start
		writeResults <- runner.Run(ctx, func(sc domain.WriteScope) error {
			changed, err := repo.WriteSlotVerdict(ctx, sc.Tx(), taskID, 2, domain.SlotTimedOut, &reason, nil, nil)
			if err == nil && !changed {
				return errors.New("timed-out slot verdict was unexpectedly rejected")
			}
			return err
		})
	}()
	close(start)
	for range 2 {
		if err := <-writeResults; err != nil {
			t.Fatalf("write concurrent slot verdict: %v", err)
		}
	}
	_, slots = assertAdvanced("concurrent slot results")
	if marker.Before(beforeConcurrentWrites.Add(2 * time.Microsecond)) {
		t.Fatalf("two concurrent detail changes advanced the marker less than twice: before=%s after=%s", beforeConcurrentWrites, marker)
	}
	if slots[1].ResultBlobKey == nil || *slots[1].ResultBlobKey != result.BlobKey {
		t.Fatalf("slot result was not visible: %+v", slots[1])
	}
	if slots[2].Status == nil || *slots[2].Status != domain.SlotTimedOut {
		t.Fatalf("concurrent slot verdict was not visible: %+v", slots[2])
	}
}
