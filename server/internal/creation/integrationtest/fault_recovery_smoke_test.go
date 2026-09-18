package integrationtest

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"
)

func TestWorkerRestartRecoversOneHundredQueuedAndTenProcessingTasks(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)

	status, body := h.doRequest(t, http.MethodPost, "/creation/sessions", token, map[string]any{"name": "fault-recovery"})
	if status != http.StatusCreated {
		t.Fatalf("create recovery session: %d %s", status, body)
	}
	sessionID := extractField(t, body, "id")
	imageIntent := h.buildTaskIntent(t, token, sessionID, taskIntent{
		MediaType: "image", Model: "doubao-seedream-5.0-pro", Mode: "text-to-image",
		Ratio: "1:1", Resolution: "2K", Quantity: 1, Prompt: "批量故障恢复图片",
	})
	videoIntent := h.buildTaskIntent(t, token, sessionID, taskIntent{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "text-to-video",
		Ratio: "16:9", Resolution: "720p", Duration: 5, Prompt: "批量故障恢复视频",
	})

	processingIDs := make([]string, 0, 10)
	allIDs := make([]string, 0, 110)
	for i := 0; i < 10; i++ {
		status, body = h.submitTask(t, token, fmt.Sprintf("fault-processing-%03d", i), videoIntent)
		if status != http.StatusCreated {
			t.Fatalf("submit processing fixture %d: %d %s", i, status, body)
		}
		id := decodeTaskView(t, body).Task.ID
		processingIDs = append(processingIDs, id)
		allIDs = append(allIDs, id)
	}
	for i := 0; i < 100; i++ {
		status, body = h.submitTask(t, token, fmt.Sprintf("fault-queued-%03d", i), imageIntent)
		if status != http.StatusCreated {
			t.Fatalf("submit queued fixture %d: %d %s", i, status, body)
		}
		allIDs = append(allIDs, decodeTaskView(t, body).Task.ID)
	}

	crash, err := h.ownerPool.Begin(h.ctx)
	if err != nil {
		t.Fatalf("begin crash fixture: %v", err)
	}
	for i, id := range processingIDs {
		if _, err := crash.Exec(h.ctx, `
			UPDATE creation_generation_tasks SET status = 'processing', updated_at = now()
			WHERE id = $1::uuid AND status = 'queued'`, id); err != nil {
			_ = crash.Rollback(h.ctx)
			t.Fatalf("mark task %d processing: %v", i, err)
		}
		if _, err := crash.Exec(h.ctx, `
			UPDATE creation_provider_jobs
			SET status = 'processing', external_ref = $2, updated_at = now()
			WHERE task_id = $1::uuid AND status = 'pending'`, id, fmt.Sprintf("fault-provider-%03d", i)); err != nil {
			_ = crash.Rollback(h.ctx)
			t.Fatalf("mark provider job %d processing: %v", i, err)
		}
	}
	if err := crash.Commit(h.ctx); err != nil {
		t.Fatalf("commit crash fixture: %v", err)
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_tasks WHERE id = ANY($1::uuid[]) AND status = 'queued'`, allIDs); got != 100 {
		t.Fatalf("pre-restart queued tasks = %d, want 100", got)
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_tasks WHERE id = ANY($1::uuid[]) AND status = 'processing'`, allIDs); got != 10 {
		t.Fatalf("pre-restart processing tasks = %d, want 10", got)
	}

	h.kapon.generation.setImage(imageScript{outputs: 1})
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 0})
	workerCtx, stopWorker := context.WithCancel(context.Background())
	workerDone := make(chan error, 1)
	go func() { workerDone <- h.creation.RunWorkers(workerCtx) }()
	deadline := time.Now().Add(60 * time.Second)
	for {
		nonterminal := countRows(t, h.ownerPool, `
			SELECT count(*) FROM creation_generation_tasks
			WHERE id = ANY($1::uuid[])
			  AND status IN ('queued', 'submitting', 'processing', 'persisting', 'cancelling')`, allIDs)
		if nonterminal == 0 {
			break
		}
		if time.Now().After(deadline) {
			stopWorker()
			<-workerDone
			t.Fatalf("restart left %d tasks nonterminal after 60 seconds", nonterminal)
		}
		time.Sleep(50 * time.Millisecond)
	}
	stopWorker()
	if err := <-workerDone; err != nil {
		t.Fatalf("stop recovery worker: %v", err)
	}

	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_tasks WHERE id = ANY($1::uuid[])`, allIDs); got != 110 {
		t.Fatalf("recovery lost tasks: %d/110 remain", got)
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_media_assets WHERE task_id = ANY($1::uuid[])`, allIDs); got != 110 {
		t.Fatalf("recovery formed %d Assets, want one per Task", got)
	}
	if got := countRows(t, h.ownerPool, `
		SELECT count(*) FROM (
			SELECT task_id, slot_index FROM creation_media_assets
			WHERE task_id = ANY($1::uuid[])
			GROUP BY task_id, slot_index HAVING count(*) > 1
		) duplicates`, allIDs); got != 0 {
		t.Fatalf("recovery formed %d duplicate Task/slot Assets", got)
	}

	restartCtx, stopRestart := context.WithCancel(context.Background())
	restartDone := make(chan error, 1)
	go func() { restartDone <- h.creation.RunWorkers(restartCtx) }()
	time.Sleep(250 * time.Millisecond)
	stopRestart()
	if err := <-restartDone; err != nil {
		t.Fatalf("stop idempotency restart: %v", err)
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_media_assets WHERE task_id = ANY($1::uuid[])`, allIDs); got != 110 {
		t.Fatalf("second restart changed the idempotent Asset count to %d", got)
	}
}
