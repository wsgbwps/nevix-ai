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

// The dismissal guard is the SQL twin of domain.TaskIsTerminal: only an owned,
// still-visible terminal task may be hidden, a repeat is the same false, and
// the hidden task keeps its readable detail.
func TestGenerationTaskDismissHidesOnlyOwnedTerminalTasks(t *testing.T) {
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
	stranger := fixtureUser(t, ownerURL)
	sessionID := fixtureSession(t, ownerURL, owner, creator)
	taskID := fixtureGenerationTask(t, ownerURL, owner, creator, sessionID)

	repo := NewGenerationTaskRepository(runtime)
	runner := writetx.New(runtime)
	dismiss := func(actor domain.UUID) bool {
		t.Helper()
		dismissed := false
		if err := runner.Run(ctx, func(sc domain.WriteScope) error {
			var err error
			dismissed, err = repo.Dismiss(ctx, sc.Tx(), actor, taskID)
			return err
		}); err != nil {
			t.Fatalf("dismiss task: %v", err)
		}
		return dismissed
	}
	dismissedAt := func() *time.Time {
		t.Helper()
		var stamped *time.Time
		if err := owner.QueryRow(ctx,
			`SELECT dismissed_at FROM creation_generation_tasks WHERE id = $1`, taskID).Scan(&stamped); err != nil {
			t.Fatalf("read dismissed_at: %v", err)
		}
		return stamped
	}

	// A task that still owes work is not dismissable.
	if dismiss(creator) {
		t.Fatal("a queued task was dismissed")
	}
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		changed, err := repo.TransitionTask(ctx, sc.Tx(), taskID, []domain.TaskStatus{domain.TaskQueued}, domain.TaskCancelled, nil)
		if err == nil && !changed {
			return errors.New("task transition was unexpectedly rejected")
		}
		return err
	}); err != nil {
		t.Fatalf("converge the task to a terminal state: %v", err)
	}
	// Neither is another member's terminal task.
	if dismiss(stranger) {
		t.Fatal("a foreign member dismissed the task")
	}
	before, _, err := repo.GetForOwner(ctx, creator, taskID)
	if err != nil {
		t.Fatalf("read task before dismissal: %v", err)
	}

	if !dismiss(creator) {
		t.Fatal("a terminal owned task was not dismissed")
	}
	firstStamp := dismissedAt()
	if firstStamp == nil {
		t.Fatal("dismissal did not stamp dismissed_at")
	}
	after, _, err := repo.GetForOwner(ctx, creator, taskID)
	if err != nil {
		t.Fatalf("read dismissed task detail: %v", err)
	}
	if !after.UpdatedAt.After(before.UpdatedAt) {
		t.Fatalf("dismissal did not advance updated_at: before=%s after=%s", before.UpdatedAt, after.UpdatedAt)
	}
	if after.Status != domain.TaskCancelled {
		t.Fatalf("dismissal rewrote the terminal status: %s", after.Status)
	}
	if listed, _, err := repo.ListBySession(ctx, creator, sessionID, nil, 10); err != nil {
		t.Fatalf("list tasks after dismissal: %v", err)
	} else if len(listed) != 0 {
		t.Fatalf("a dismissed task stayed in the browsing list: %+v", listed)
	}

	// A repeat DELETE is the same vanished target, and the sticky fact never
	// moves — a later result cannot bring the card back.
	if dismiss(creator) {
		t.Fatal("a repeat dismissal reported success")
	}
	if againStamp := dismissedAt(); !againStamp.Equal(*firstStamp) {
		t.Fatalf("repeat dismissal rewrote the sticky fact: %s -> %s", firstStamp, againStamp)
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

	// Deleting the slot's Media Asset removes its result from the detail
	// (ADR-0021) without touching the slot row, so the criterion must move with
	// the projection rather than with a task write.
	assets := NewMediaAssetRepository(runtime)
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		_, err := assets.InsertMediaAsset(ctx, sc.Tx(), domain.MediaAssetFormation{
			OwnerID: creator, TaskID: taskID, SlotIndex: 1, MediaType: domain.MediaImage,
			Mime: "image/png", BlobKey: result.BlobKey, ByteSize: result.ByteSize, Checksum: result.Checksum,
		})
		return err
	}); err != nil {
		t.Fatalf("form the succeeded slot's asset: %v", err)
	}
	var assetID domain.UUID
	if err := owner.QueryRow(ctx,
		`SELECT id FROM creation_media_assets WHERE task_id = $1 AND slot_index = 1`, taskID).Scan(&assetID); err != nil {
		t.Fatalf("read formed asset: %v", err)
	}
	if _, err := softDelete(ctx, runner, assets, creator, assetID, false); err != nil {
		t.Fatalf("delete the slot's asset: %v", err)
	}
	// This task's only formed asset is the one just removed, so the task-level
	// projection stops listing it while the detail still reads its facts —
	// the criterion assertion below is the one assertAdvanced cannot make here.
	removed, removedSlots, err := repo.GetForOwner(ctx, creator, taskID)
	if err != nil {
		t.Fatalf("read detail after asset removal: %v", err)
	}
	if !removed.UpdatedAt.After(marker) {
		t.Fatalf("asset removal: updated_at did not advance: before=%s after=%s", marker, removed.UpdatedAt)
	}
	if !removedSlots[1].ResultDeleted || removedSlots[1].ResultReadable() {
		t.Fatalf("removed slot result was not projected: %+v", removedSlots[1])
	}
	if listed, _, err := repo.ListBySession(ctx, creator, sessionID, nil, 10); err != nil {
		t.Fatalf("list tasks after asset removal: %v", err)
	} else if len(listed) != 0 {
		t.Fatalf("task whose every formed asset is removed stayed listed: %+v", listed)
	}
	marker = removed.UpdatedAt
	if _, err := softDelete(ctx, runner, assets, creator, assetID, false); !errors.Is(err, domain.ErrAssetNotFound) {
		t.Fatalf("repeat asset delete error=%v, want ErrAssetNotFound", err)
	}
	afterRepeatDelete, _, err := repo.GetForOwner(ctx, creator, taskID)
	if err != nil {
		t.Fatalf("read repeated asset delete: %v", err)
	}
	if !afterRepeatDelete.UpdatedAt.Equal(marker) {
		t.Fatalf("repeated asset delete changed the detail criterion: before=%s after=%s", marker, afterRepeatDelete.UpdatedAt)
	}

	// Dismissing the task (ADR-0022) lands on a task with no live result left,
	// so the criterion must move with the dismissal itself — a dismissal whose
	// updated_at did not advance would silently defeat every reader's
	// check-for-changes. Only a terminal task is dismissable.
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		changed, err := repo.TransitionTask(ctx, sc.Tx(), taskID, []domain.TaskStatus{domain.TaskSubmitting}, domain.TaskFailed, nil)
		if err == nil && !changed {
			return errors.New("terminal transition was unexpectedly rejected")
		}
		return err
	}); err != nil {
		t.Fatalf("converge the task to a terminal state: %v", err)
	}
	dismissed, _, err := repo.GetForOwner(ctx, creator, taskID)
	if err != nil {
		t.Fatalf("read detail after terminal transition: %v", err)
	}
	if !dismissed.UpdatedAt.After(marker) {
		t.Fatalf("terminal transition: updated_at did not advance: before=%s after=%s", marker, dismissed.UpdatedAt)
	}
	marker = dismissed.UpdatedAt
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		changed, err := repo.Dismiss(ctx, sc.Tx(), creator, taskID)
		if err == nil && !changed {
			return errors.New("dismissal of a terminal owned task was unexpectedly rejected")
		}
		return err
	}); err != nil {
		t.Fatalf("dismiss task: %v", err)
	}
	afterDismiss, _, err := repo.GetForOwner(ctx, creator, taskID)
	if err != nil {
		t.Fatalf("read detail after dismissal: %v", err)
	}
	if !afterDismiss.UpdatedAt.After(marker) {
		t.Fatalf("dismissal: updated_at did not advance: before=%s after=%s", marker, afterDismiss.UpdatedAt)
	}
	var dismissedAt *time.Time
	if err := owner.QueryRow(ctx,
		`SELECT dismissed_at FROM creation_generation_tasks WHERE id = $1`, taskID).Scan(&dismissedAt); err != nil {
		t.Fatalf("read dismissed_at: %v", err)
	}
	if dismissedAt == nil {
		t.Fatal("dismissal did not stamp dismissed_at")
	}
}
