package integrationtest

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// Worker-driven task lifecycle scenarios (issue #159): real queue worker,
// real filesystem storage, fake Kapon generation endpoints, and the
// one-way state machine observed end to end through public HTTP.

// TestImageTaskLifecycleReachesSucceeded: a synchronous image task advances
// queued → submitting → persisting → succeeded, transfers and verifies every
// output, and exposes creator-private downloadable results.
func TestImageTaskLifecycleReachesSucceeded(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})

	draft := h.saveImageDraft(t, token, "两张输出", 2)
	status, body := h.submitTask(t, token, draft.SessionID, "img-life", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	view = h.awaitTaskTerminal(t, token, view.Task.ID)

	if view.Task.Status != "succeeded" {
		t.Fatalf("image task must succeed, got %s (%s)", view.Task.Status, slotVerdicts(view))
	}
	for _, slot := range view.Slots {
		if slot.Status != "succeeded" || slot.Result == nil {
			t.Fatalf("every slot must succeed with a result: %s", slotVerdicts(view))
		}
		if slot.Result.MimeType != "image/png" || slot.Result.WidthPx == nil {
			t.Fatalf("verified PNG facts missing: %+v", slot.Result)
		}
	}

	// Reservation released exactly once at the first terminal transition.
	taskID := view.Task.ID
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_reservations WHERE task_id = $1::uuid AND released_at IS NULL`, taskID); got != 0 {
		t.Fatalf("terminal task must release its reservation, got %d active", got)
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_reservations WHERE task_id = $1::uuid AND released_at IS NOT NULL`, taskID); got != 1 {
		t.Fatalf("reservation must release exactly once, got %d releases", got)
	}

	// The creator can download the verified output.
	status, raw := h.doRequest(t, "GET", "/creation/tasks/"+taskID+"/slots/0/result", token, nil)
	if status != http.StatusOK {
		t.Fatalf("result download must answer 200, got %d", status)
	}
	if len(raw) == 0 {
		t.Fatal("result download must carry bytes")
	}
	// A foreign creator gets the uniform 404.
	otherToken := h.loginToken(t, otherCreatorEmail, harnessPassword)
	if status, _ := h.doRequest(t, "GET", "/creation/tasks/"+taskID+"/slots/0/result", otherToken, nil); status != http.StatusNotFound {
		t.Fatalf("foreign download must be 404, got %d", status)
	}
}

// TestVideoTaskLifecycleRunsAsync: the async video task polls through
// processing before persisting a verified MP4 result.
func TestVideoTaskLifecycleRunsAsync(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 5})

	status, body := h.doRequest(t, "POST", "/creation/sessions", token, map[string]any{"name": "video"})
	if status != http.StatusCreated {
		t.Fatalf("create session: %d", status)
	}
	sessionID := extractField(t, body, "id")
	draft := h.saveDraftOn(t, token, sessionID, taskDraft{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "text-to-video",
		Resolution: "720p", Duration: 5, Prompt: "一段商品运镜视频",
	})
	status, body = h.submitTask(t, token, sessionID, "vid-life", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	view = h.awaitTaskTerminal(t, token, view.Task.ID)
	if view.Task.Status != "succeeded" || len(view.Slots) != 1 || view.Slots[0].Result == nil {
		t.Fatalf("video task must succeed with one result: %s (%s)", view.Task.Status, slotVerdicts(view))
	}
	result := view.Slots[0].Result
	if result.MimeType != "video/mp4" || result.DurationMS == nil || *result.DurationMS != 5000 {
		t.Fatalf("verified MP4 facts missing: %+v", result)
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_provider_jobs WHERE task_id = $1::uuid AND status = 'completed'`, view.Task.ID); got != 1 {
		t.Fatalf("one completed provider job expected, got %d", got)
	}
	if got := h.kapon.generation.videoRequests(); got < 6 {
		t.Fatalf("accepted async work must retain its independent poll budget, got %d provider requests", got)
	}
}

// TestPartialSuccessKeepsEverySucceededSlot: a provider shortfall fails only
// the missing slots and the task aggregates partially_succeeded; retrying
// the uncompleted slots creates a brand-new task.
func TestPartialSuccessKeepsEverySucceededSlotAndRetryCreatesNewTask(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1, emptyOutputsOn: 2})

	draft := h.saveImageDraft(t, token, "部分成功", 3)
	status, body := h.submitTask(t, token, draft.SessionID, "partial", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	view = h.awaitTaskTerminal(t, token, view.Task.ID)
	if view.Task.Status != "partially_succeeded" {
		t.Fatalf("shortfall must aggregate partially_succeeded, got %s (%s)", view.Task.Status, slotVerdicts(view))
	}
	succeeded, failed := 0, 0
	for _, slot := range view.Slots {
		switch slot.Status {
		case "succeeded":
			succeeded++
		case "failed":
			if slot.FailureReason == nil || *slot.FailureReason != "temporarily_unavailable" {
				t.Fatalf("shortfall slots fail as temporarily_unavailable, got %v", slot.FailureReason)
			}
			failed++
		default:
			t.Fatalf("unexpected slot verdict: %s", slotVerdicts(view))
		}
	}
	if succeeded != 2 || failed != 1 {
		t.Fatalf("expected 2 succeeded + 1 failed, got %s", slotVerdicts(view))
	}
	originalID := view.Task.ID

	// Retry uncompleted: new idempotency key, new task with one slot, the
	// original task untouched.
	status, body = h.doRequest(t, "POST", "/creation/tasks/"+originalID+"/retry", token, map[string]any{"idempotency_key": "retry-1"})
	if status != http.StatusCreated {
		t.Fatalf("retry must create a task, got %d: %s", status, body)
	}
	retried := decodeTaskView(t, body)
	if retried.Task.ID == originalID || retried.Task.SlotCount != 1 {
		t.Fatalf("retry must create a new single-slot task, got %+v", retried.Task)
	}
	retried = h.awaitTaskTerminal(t, token, retried.Task.ID)
	if retried.Task.Status != "succeeded" {
		t.Fatalf("retried slot must succeed: %s", retried.Task.Status)
	}
	if _, _, original := h.getTask(t, token, originalID); original.Task.Status != "partially_succeeded" {
		t.Fatal("the original task stays immutable")
	}
	// Same retry key replays the same new task.
	status, body = h.doRequest(t, "POST", "/creation/tasks/"+originalID+"/retry", token, map[string]any{"idempotency_key": "retry-1"})
	if status != http.StatusOK || decodeTaskView(t, body).Task.ID == originalID {
		t.Fatal("retry replay must return the retried task")
	}
}

// TestCancelConvergesBestEffort: an unsubmitted task cancels immediately; a
// running one keeps its succeeded outputs.
func TestCancelConvergesBestEffort(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)

	// 1) Unsubmitted: cancel converges immediately without external work.
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 1000})
	draft := h.saveImageDraft(t, token, "立即取消", 1)
	status, body := h.submitTask(t, token, draft.SessionID, "cancel-queued", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	status, body = h.doRequest(t, "POST", "/creation/tasks/"+view.Task.ID+"/cancel", token, nil)
	if status != http.StatusOK {
		t.Fatalf("cancel: %d %s", status, body)
	}
	canceled := h.awaitTaskTerminal(t, token, view.Task.ID)
	if canceled.Task.Status != "cancelled" {
		t.Fatalf("unsubmitted task must cancel, got %s", canceled.Task.Status)
	}
	for _, slot := range canceled.Slots {
		if slot.Status != "cancelled" {
			t.Fatalf("all slots must be cancelled: %s", slotVerdicts(canceled))
		}
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_reservations WHERE task_id = $1::uuid AND released_at IS NULL`, view.Task.ID); got != 0 {
		t.Fatal("cancel must release the reservation")
	}
	// Idempotent repeat answers the current state.
	if status, _ := h.doRequest(t, "POST", "/creation/tasks/"+view.Task.ID+"/cancel", token, nil); status != http.StatusOK {
		t.Fatal("repeated cancel must stay 200")
	}

	// 2) Accepted video work keeps converging; cancel cannot fabricate a
	// provider verdict, so the task still finishes succeeded with outputs.
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 2, cancelOK: true})
	status, body = h.doRequest(t, "POST", "/creation/sessions", token, map[string]any{"name": "cancel-video"})
	if status != http.StatusCreated {
		t.Fatal("session")
	}
	sessionID := extractField(t, body, "id")
	videoDraft := h.saveDraftOn(t, token, sessionID, taskDraft{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "text-to-video",
		Resolution: "720p", Duration: 5, Prompt: "取消收敛",
	})
	status, body = h.submitTask(t, token, sessionID, "cancel-running", videoDraft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	running := decodeTaskView(t, body)
	// Give the worker a moment to accept the job, then request cancel.
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, _, current := h.getTask(t, token, running.Task.ID)
		if current.Task.Status == "processing" || current.Task.Status == "submitting" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("task never started external work: %s", current.Task.Status)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if cancelStatus, cancelBody := h.doRequest(t, "POST", "/creation/tasks/"+running.Task.ID+"/cancel", token, nil); cancelStatus != http.StatusOK {
		t.Fatalf("cancel request failed: %d %s", cancelStatus, cancelBody)
	}
	converged := h.awaitTaskTerminal(t, token, running.Task.ID)
	if converged.Task.Status != "succeeded" {
		t.Fatalf("accepted work with retained outputs must converge succeeded, got %s (%s)", converged.Task.Status, slotVerdicts(converged))
	}
}

// TestCancelOfReflessSubmitConverges: a cancel requested while the job is
// held submitting without an external identity (transient-rejection backoff)
// converges cancelled — the cancelling path never touches a missing
// external ref.
func TestCancelOfReflessSubmitConverges(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{status: http.StatusTooManyRequests})

	draft := h.saveImageDraft(t, token, "取消未受理提交", 1)
	status, body := h.submitTask(t, token, draft.SessionID, "cancel-refless", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)

	deadline := time.Now().Add(10 * time.Second)
	for {
		if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_provider_jobs WHERE task_id = $1::uuid AND status = 'submitting' AND external_ref IS NULL AND last_outcome = 'transient_rejected'`, view.Task.ID); got == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("job never entered the ref-less submitting hold")
		}
		time.Sleep(20 * time.Millisecond)
	}

	if status, body = h.doRequest(t, "POST", "/creation/tasks/"+view.Task.ID+"/cancel", token, nil); status != http.StatusOK {
		t.Fatalf("cancel: %d %s", status, body)
	}
	converged := h.awaitTaskTerminal(t, token, view.Task.ID)
	if converged.Task.Status != "cancelled" {
		t.Fatalf("a submit that never obtained an external identity must cancel, got %s (%s)", converged.Task.Status, slotVerdicts(converged))
	}
	for _, slot := range converged.Slots {
		if slot.Status != "cancelled" {
			t.Fatalf("every slot must end cancelled: %s", slotVerdicts(converged))
		}
	}
}

// TestIndeterminateSubmitNeverAutoRetries: a lost submit outcome ends the
// job indeterminate, the task failed with the indeterminate cause, and no
// new provider request is ever guessed.
func TestIndeterminateSubmitNeverAutoRetries(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{abort: true})

	draft := h.saveImageDraft(t, token, "未知结局", 1)
	status, body := h.submitTask(t, token, draft.SessionID, "indeterminate", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	view = h.awaitTaskTerminal(t, token, view.Task.ID)
	if view.Task.Status != "failed" || view.Task.TerminalCause == nil || *view.Task.TerminalCause != "provider_outcome_indeterminate" {
		t.Fatalf("lost submit must fail with the indeterminate cause, got %s %v", view.Task.Status, view.Task.TerminalCause)
	}
	for _, slot := range view.Slots {
		if slot.Status != "indeterminate" || slot.FailureReason == nil || *slot.FailureReason != "processing_indeterminate" {
			t.Fatalf("slots must end indeterminate/processing_indeterminate: %s", slotVerdicts(view))
		}
	}
	// No guessing: exactly one external submit attempt ever happened.
	if got := h.kapon.generation.imageRequests(); got != 1 {
		t.Fatalf("indeterminate must never auto-retry, observed %d submit attempts", got)
	}
}

// TestProvider402PersistsCreditBlock: the first explicit 402 establishes the
// connection-wide persistent block, converges the task as action_required,
// and blocks new submissions until an admin clears it.
func TestProvider402PersistsCreditBlock(t *testing.T) {
	h, adminToken, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creatorToken := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{status: http.StatusPaymentRequired})

	draft := h.saveImageDraft(t, creatorToken, "额度耗尽", 1)
	status, body := h.submitTask(t, creatorToken, draft.SessionID, "credit-1", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	view = h.awaitTaskTerminal(t, creatorToken, view.Task.ID)
	if view.Task.Status != "failed" {
		t.Fatalf("402 task must fail, got %s", view.Task.Status)
	}
	for _, slot := range view.Slots {
		if slot.FailureReason == nil || *slot.FailureReason != "action_required" {
			t.Fatalf("402 slots fail action_required: %s", slotVerdicts(view))
		}
	}
	if blocked := countRows(t, h.ownerPool, `SELECT count(*) FROM provider_connections WHERE credit_blocked_at IS NOT NULL`); blocked != 1 {
		t.Fatal("the first 402 must persist the connection-level credit block")
	}

	// Admission now rejects with the stable reason at 403.
	status, body = h.submitTask(t, creatorToken, draft.SessionID, "credit-2", draft.Revision)
	if status != http.StatusForbidden {
		t.Fatalf("blocked submission must 403, got %d", status)
	}
	assertErrorCode(t, body, "provider_credit_blocked")

	// Admin clears; the next submission probes and (now succeeding) admits.
	h.kapon.generation.setImage(imageScript{outputs: 1})
	if status, raw := h.doRequest(t, "DELETE", "/creation/provider-connection/credit-block", adminToken, nil); status != http.StatusNoContent {
		t.Fatalf("clear credit block: %d %s", status, raw)
	}
	status, body = h.submitTask(t, creatorToken, draft.SessionID, "credit-3", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("cleared submission must admit, got %d: %s", status, body)
	}
}

// TestProviderRateLimitedBacksOffBounded: an explicit 429 keeps the job
// pending with backoff (never terminal) and then converges when the
// provider recovers.
func TestProviderRateLimitedBacksOffBounded(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{status: http.StatusTooManyRequests})

	draft := h.saveImageDraft(t, token, "限速退避", 1)
	status, body := h.submitTask(t, token, draft.SessionID, "rate-1", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, current := h.getTask(t, token, view.Task.ID); current.Task.Status == "submitting" {
			break // the marker persisted; the job is backing off, not terminal
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Recovery: the provider opens and the same task converges.
	h.kapon.generation.setImage(imageScript{outputs: 1})
	converged := h.awaitTaskTerminal(t, token, view.Task.ID)
	if converged.Task.Status != "succeeded" {
		t.Fatalf("recovered provider must converge the task, got %s (%s)", converged.Task.Status, slotVerdicts(converged))
	}
}

// TestPausedConnectionHoldsUnstartedCalls: pause blocks new tasks at
// admission and holds not-yet-started provider calls, while an accepted job
// keeps converging.
func TestPausedConnectionHoldsUnstartedCalls(t *testing.T) {
	h, adminToken, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creatorToken := h.loginToken(t, creator, harnessPassword)

	// Accept a video job first, then pause before its first poll.
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 1000})
	draft := h.saveImageDraft(t, creatorToken, "暂停前任务", 1)
	_ = draft

	status, body := h.doRequest(t, "POST", "/creation/sessions", creatorToken, map[string]any{"name": "pause"})
	if status != http.StatusCreated {
		t.Fatal("session")
	}
	sessionID := extractField(t, body, "id")
	videoDraft := h.saveDraftOn(t, creatorToken, sessionID, taskDraft{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "text-to-video",
		Resolution: "720p", Duration: 5, Prompt: "暂停收敛",
	})
	status, body = h.submitTask(t, creatorToken, sessionID, "pause-accepted", videoDraft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	accepted := decodeTaskView(t, body)
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, current := h.getTask(t, creatorToken, accepted.Task.ID); current.Task.Status == "processing" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("accepted job never started")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status, _ := h.doRequest(t, "PATCH", "/creation/provider-connection", adminToken, map[string]string{"admin_state": "paused"}); status != http.StatusOK {
		t.Fatal("pause must succeed")
	}

	// Pause blocks new tasks at admission with the stable capability reason.
	h.kapon.generation.setImage(imageScript{outputs: 1})
	status, body = h.submitTask(t, creatorToken, draft.SessionID, "pause-queued", draft.Revision)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("paused admission must reject new tasks, got %d: %s", status, body)
	}
	assertErrorCode(t, body, "media_unavailable")

	// Resume: the provider opens and the accepted job converges.
	if status, _ := h.doRequest(t, "PATCH", "/creation/provider-connection", adminToken, map[string]string{"admin_state": "enabled"}); status != http.StatusOK {
		t.Fatal("resume must succeed")
	}
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 1})
	converged := h.awaitTaskTerminal(t, creatorToken, accepted.Task.ID)
	if converged.Task.Status != "succeeded" {
		t.Fatalf("accepted job must converge after resume, got %s", converged.Task.Status)
	}
}

// TestLocalCrashNeverFabricatesTimeout: with the provider silent (neither
// success nor authoritative verdict), a task stays non-terminal — a stopped
// worker never produces business timed_out from local timeout alone.
func TestLocalCrashNeverFabricatesTimeout(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	// The provider stays silent-queued: no authoritative answer, no local
	// deadline may end the task.
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 1 << 30})

	draft := h.saveImageDraft(t, token, "静默供应商", 1)
	_ = draft
	status, body := h.doRequest(t, "POST", "/creation/sessions", token, map[string]any{"name": "silent"})
	if status != http.StatusCreated {
		t.Fatal("session")
	}
	sessionID := extractField(t, body, "id")
	videoDraft := h.saveDraftOn(t, token, sessionID, taskDraft{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "text-to-video",
		Resolution: "720p", Duration: 5, Prompt: "永不本地超时",
	})
	status, body = h.submitTask(t, token, sessionID, "silent-1", videoDraft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := decodeTaskView(t, body)
	time.Sleep(2 * time.Second)
	_, _, current := h.getTask(t, token, view.Task.ID)
	switch current.Task.Status {
	case "queued", "submitting", "processing":
		// Correct: still owed work, no fabricated terminal state.
	default:
		t.Fatalf("a silent provider must never fabricate a terminal state, got %s", current.Task.Status)
	}
	if current.Task.Status == "timed_out" {
		t.Fatal("local waiting must never end as business timed_out")
	}
	_ = context.Background()
}

// TestCompletedJobSurvivesCredentialUnavailability: a job that already
// settled provider-side (persist-phase crash recovery) holds as transient
// while the call credential is unresolvable, and its outputs still form
// assets once the credential returns — the completed job's outputs are never
// discarded as a nil-reason terminal failure (issue #160 review).
func TestCompletedJobSurvivesCredentialUnavailability(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 1 << 30})

	status, body := h.doRequest(t, "POST", "/creation/sessions", token, map[string]any{"name": "sealed"})
	if status != http.StatusCreated {
		t.Fatalf("create session: %d", status)
	}
	sessionID := extractField(t, body, "id")
	draft := h.saveDraftOn(t, token, sessionID, taskDraft{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "text-to-video",
		Resolution: "720p", Duration: 5, Prompt: "凭据恢复后继续收敛",
	})
	status, body = h.submitTask(t, token, sessionID, "sealed-1", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	taskID := decodeTaskView(t, body).Task.ID

	// Wait until the job is mid-flight (processing with an external ref).
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		_, _, view := h.getTask(t, token, taskID)
		if view.Task.Status == "processing" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_provider_jobs WHERE task_id = $1::uuid AND status = 'processing' AND external_ref IS NOT NULL`, taskID); got != 1 {
		t.Fatalf("processing job with external ref expected, got %d", got)
	}

	// Simulate the persist-phase crash state: the job settled provider-side
	// (completed) while the task's slots never landed.
	if _, err := h.ownerPool.Exec(h.ctx,
		`UPDATE creation_provider_jobs SET status = 'completed', terminal_at = now() WHERE task_id = $1::uuid`, taskID); err != nil {
		t.Fatalf("mark job completed: %v", err)
	}

	// Seal the master key: the call credential cannot be resolved, so the
	// completed job must hold transiently instead of converging to a
	// nil-reason failure that would discard its transferable outputs.
	if err := os.Chmod(h.secretsDir, 0o000); err != nil {
		t.Fatalf("seal secrets dir: %v", err)
	}
	holdDeadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(holdDeadline) {
		_, _, view := h.getTask(t, token, taskID)
		if isTerminalStatus(view.Task.Status) {
			t.Fatalf("sealed credential must hold the task open, got %s (%s)", view.Task.Status, slotVerdicts(view))
		}
		time.Sleep(200 * time.Millisecond)
	}

	// The credential returns and the provider answers with its outputs: the
	// same job converges succeeded with a formed asset — no new generation.
	if err := os.Chmod(h.secretsDir, 0o700); err != nil {
		t.Fatalf("unseal secrets dir: %v", err)
	}
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 0})
	view := h.awaitTaskTerminal(t, token, taskID)
	if view.Task.Status != "succeeded" {
		t.Fatalf("recovered job must succeed, got %s (%s)", view.Task.Status, slotVerdicts(view))
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_provider_jobs WHERE task_id = $1::uuid`, taskID); got != 1 {
		t.Fatalf("recovery must not create a second external attempt, got %d jobs", got)
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_media_assets WHERE task_id = $1::uuid`, taskID); got != 1 {
		t.Fatalf("the completed job's output must form its asset, got %d", got)
	}
}

// TestTransientRejectionAttemptLimitConverges: the provider's four-step
// transient-submit ladder is also the durable call budget. Once spent, the
// task exposes a retryable terminal verdict instead of silently waiting on
// the queue-wide 240-attempt allowance (issue #160 field report:
// last_outcome=transient_rejected, no error).
func TestTransientRejectionAttemptLimitConverges(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	one := 1
	h.kapon.generation.setImage(imageScript{
		status: http.StatusTooManyRequests, retryAfterSeconds: &one,
	})

	draft := h.saveImageDraft(t, token, "预算耗尽", 1)
	status, body := h.submitTask(t, token, draft.SessionID, "exhaust-1", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	taskID := decodeTaskView(t, body).Task.ID

	// Wait for exactly one provider call, then inflate the unrelated queue
	// claim count. A correct implementation still permits three more submit
	// calls because submit_attempts is the durable budget owner.
	deadline := time.Now().Add(10 * time.Second)
	for {
		if got := countRows(t, h.ownerPool,
			`SELECT count(*) FROM creation_provider_jobs WHERE task_id = $1::uuid AND last_outcome = 'transient_rejected' AND submit_attempts = 1`, taskID); got == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the first transient rejection was never recorded")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := h.ownerPool.Exec(h.ctx,
		`UPDATE creation_generation_queue SET attempts = 200 WHERE task_id = $1::uuid`, taskID); err != nil {
		t.Fatalf("inflate the independent queue-claim budget: %v", err)
	}
	// Keep the first three waits fast, then make the limiting answer match
	// the real Kapon response observed for issue #160. The worker must retain
	// retry semantics while preserving the allowlisted terminal diagnosis.
	deadline = time.Now().Add(10 * time.Second)
	for {
		if got := countRows(t, h.ownerPool,
			`SELECT count(*) FROM creation_provider_jobs WHERE task_id = $1::uuid AND last_outcome = 'transient_rejected' AND submit_attempts = 3`, taskID); got == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the third transient rejection was never recorded")
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.kapon.generation.setImage(imageScript{
		status: http.StatusServiceUnavailable, code: "MODEL_GROUP_ALL_UNAVAILABLE",
	})

	converged := h.awaitTaskTerminal(t, token, taskID)
	if converged.Task.Status != "failed" {
		t.Fatalf("exhausted transient retries must converge failed, got %s (%s)", converged.Task.Status, slotVerdicts(converged))
	}
	for _, slot := range converged.Slots {
		if slot.Status != "failed" || slot.FailureReason == nil || *slot.FailureReason != "provider_route_unavailable" {
			t.Fatalf("the limiting model-route 503 must retain its stable diagnosis: %s", slotVerdicts(converged))
		}
		diagnostic := slot.FailureDiagnostic
		if diagnostic == nil || diagnostic.Source != "provider" ||
			diagnostic.Code != "MODEL_GROUP_ALL_UNAVAILABLE" ||
			diagnostic.Message != "provider-private-detail" ||
			diagnostic.RequestID == nil || *diagnostic.RequestID != "kapon-private-request-id" ||
			diagnostic.HTTPStatus == nil || *diagnostic.HTTPStatus != http.StatusServiceUnavailable {
			t.Fatalf("the creator-private Kapon diagnostic must survive: %+v", diagnostic)
		}
	}
	terminalStatus, terminalBody, _ := h.getTask(t, token, taskID)
	if terminalStatus != http.StatusOK {
		t.Fatalf("get terminal task: %d %s", terminalStatus, terminalBody)
	}
	assertContractResponse(t, http.MethodGet, "/creation/tasks/"+taskID, terminalStatus, terminalBody)
	for _, required := range []string{"MODEL_GROUP_ALL_UNAVAILABLE", "provider-private-detail", "kapon-private-request-id"} {
		if !strings.Contains(string(terminalBody), required) {
			t.Fatalf("task API dropped creator-private provider response field %q: %s", required, terminalBody)
		}
	}
	if got := countRows(t, h.ownerPool,
		`SELECT count(*) FROM creation_generation_reservations WHERE task_id = $1::uuid AND released_at IS NOT NULL`, taskID); got != 1 {
		t.Fatal("exhaustion must release the reservation exactly once")
	}
	if got := h.kapon.generation.imageRequests(); got != 4 {
		t.Fatalf("the four-step transient-submit budget must make 4 provider calls, got %d", got)
	}
	if got := countRows(t, h.ownerPool,
		`SELECT count(*) FROM creation_provider_jobs WHERE task_id = $1::uuid AND status = 'failed' AND submit_attempts = 4 AND last_outcome IS NULL`, taskID); got != 1 {
		t.Fatal("the limiting rejection and terminal provider-job verdict must commit together")
	}
	if got := countRows(t, h.ownerPool,
		`SELECT count(*) FROM creation_generation_queue WHERE task_id = $1::uuid AND attempts >= max_attempts`, taskID); got != 1 {
		t.Fatal("the exhausted queue item must stay retired (attempts saturated)")
	}
}

// isTerminalStatus reports whether a wire task status is one of the five
// terminal states.
func isTerminalStatus(status string) bool {
	switch status {
	case "succeeded", "partially_succeeded", "failed", "cancelled", "timed_out":
		return true
	}
	return false
}
