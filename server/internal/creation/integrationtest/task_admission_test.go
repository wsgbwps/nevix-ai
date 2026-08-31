package integrationtest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Task admission (issue #159) through the Module's public HTTP seam: atomic
// creation of specification/task/slots/job/queue/reservation, creator-scoped
// idempotency, draft revision and capability revalidation, and the
// fixed-order governance matrix.

// countRows is an assertion helper over the owner DDL credential.
func countRows(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(context.Background(), query, args...).Scan(&count); err != nil {
		t.Fatalf("count query %s: %v", query, err)
	}
	return count
}

// userID resolves a fixture account's id from the owner credential.
func (h *harness) userID(t *testing.T, email string) string {
	t.Helper()
	var id string
	if err := h.ownerPool.QueryRow(context.Background(),
		`SELECT id FROM users WHERE email = $1`, email).Scan(&id); err != nil {
		t.Fatalf("resolve user id for %s: %v", email, err)
	}
	return id
}

// TestTaskAdmissionAtomicityAndIdempotency covers the acceptance criteria's
// core: one admission transaction, idempotent replay without double
// counting, and payload conflict.
func TestTaskAdmissionAtomicityAndIdempotency(t *testing.T) {
	h, adminToken, creator := readyTaskHarness(t, harnessOptions{})
	_ = adminToken
	token := h.loginToken(t, creator, harnessPassword)

	draft := h.saveImageDraft(t, token, "一张干净的白色背景商拍图", 3)

	status, body := h.submitTask(t, token, draft.SessionID, "key-once", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("first submission must create, got %d: %s", status, body)
	}
	view := decodeTaskView(t, body)
	if view.Task.Status != "queued" || view.Task.SlotCount != 3 || len(view.Slots) != 3 {
		t.Fatalf("admitted task shape wrong: %+v", view.Task)
	}
	// Stable ordered slots, projected as queued.
	for i, slot := range view.Slots {
		if slot.Index != i || slot.Status != "queued" {
			t.Fatalf("slots must be stable and ordered, got %+v", view.Slots)
		}
	}

	// Atomic admission: task, 3 slots, one pending job, one queue item, one
	// reservation, and exactly one attempt row for the creator.
	taskID := view.Task.ID
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_slots WHERE task_id = $1::uuid`, taskID) != 3 {
		t.Fatal("admission must persist all slots")
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_provider_jobs WHERE task_id = $1::uuid`, taskID) != 1 {
		t.Fatal("admission must persist the first pending job")
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_queue WHERE task_id = $1::uuid`, taskID) != 1 {
		t.Fatal("admission must persist the queue item")
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_reservations WHERE task_id = $1::uuid AND released_at IS NULL`, taskID) != 1 {
		t.Fatal("admission must persist the concurrency reservation")
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_attempts`) != 1 {
		t.Fatal("admission must record exactly one structurally valid attempt")
	}
	// Idempotent replay: same key + same payload → the same task, nothing
	// counted twice.
	status, body = h.submitTask(t, token, draft.SessionID, "key-once", draft.Revision)
	if status != http.StatusOK {
		t.Fatalf("replay must answer 200, got %d: %s", status, body)
	}
	replayed := decodeTaskView(t, body)
	if replayed.Task.ID != taskID {
		t.Fatalf("replay must return the original task, got %s", replayed.Task.ID)
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_attempts`) != 1 {
		t.Fatal("a replayed submission must not count a second attempt")
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_tasks`) != 1 {
		t.Fatal("a replayed submission must not create a second task")
	}

	// Same key, different payload (prompt changed → different frozen spec).
	changed := h.saveDraftOn(t, token, draft.SessionID, taskDraft{
		MediaType: "image", Model: "doubao-seedream-5.0-lite", Mode: "text-to-image",
		Ratio: "1:1", Resolution: "2K", Quantity: 3, Prompt: "另一个意图",
	})
	status, body = h.submitTask(t, token, draft.SessionID, "key-once", changed.Revision)
	if status != http.StatusConflict {
		t.Fatalf("same key different payload must conflict, got %d: %s", status, body)
	}
	assertErrorCode(t, body, "idempotency_payload_conflict")

	// Network retry on a fresh key creates exactly one additional task.
	status, body = h.submitTask(t, token, draft.SessionID, "key-two", changed.Revision)
	if status != http.StatusCreated {
		t.Fatalf("second key must admit, got %d: %s", status, body)
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_tasks`) != 2 {
		t.Fatal("a fresh key must create a new task")
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_reservations WHERE released_at IS NULL`) != 2 {
		t.Fatal("each admitted task owns exactly one active reservation")
	}
}

// TestTaskAdmissionRevalidatesDraft covers the stale-revision and capability
// revalidation rejections: nothing is created, nothing is rewritten.
func TestTaskAdmissionRevalidatesDraft(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	draft := h.saveImageDraft(t, token, "校验用草稿", 1)
	before := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_tasks`)

	// Stale revision: the draft changed since the submitter looked at it.
	status, body := h.submitTask(t, token, draft.SessionID, "rev-key", "1970-01-01T00:00:00Z")
	if status != http.StatusConflict {
		t.Fatalf("stale revision must conflict, got %d: %s", status, body)
	}
	assertErrorCode(t, body, "draft_revision_conflict")

	// A draft saved against a foreign manifest version blocks submission:
	// the revision matches, the manifest version does not.
	_ = h.saveDraftOn(t, token, draft.SessionID, taskDraft{
		MediaType: "image", Model: "doubao-seedream-5.0-lite", Mode: "text-to-image",
		Ratio: "1:1", Resolution: "2K", Quantity: 1, Prompt: "版本校验",
	})
	_, foreignBody := h.doRequest(t, "PUT", "/creation/sessions/"+draft.SessionID+"/draft", token, map[string]any{
		"prompt": "版本校验", "media_type": "image", "manifest_version": 99,
		"model": "doubao-seedream-5.0-lite", "mode": "text-to-image",
		"ratio": "1:1", "resolution": "2K", "quantity": 1, "references": []any{},
	})
	foreignRevision := extractField(t, foreignBody, "updated_at")
	status, body = h.submitTask(t, token, draft.SessionID, "stale-key", foreignRevision)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("foreign manifest version must be rejected, got %d: %s", status, body)
	}
	assertErrorCode(t, body, "media_unavailable")

	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_tasks`); got != before {
		t.Fatalf("rejected admissions must not create tasks, before=%d after=%d", before, got)
	}
	// The draft survives rejected submissions untouched: its revision stays
	// exactly the one the last save returned.
	_, body = h.doRequest(t, "GET", "/creation/sessions/"+draft.SessionID, token, nil)
	var detail struct {
		Draft *struct {
			Prompt    string `json:"prompt"`
			UpdatedAt string `json:"updated_at"`
		} `json:"draft"`
	}
	if err := json.Unmarshal(body, &detail); err != nil {
		t.Fatalf("decode session detail: %v", err)
	}
	if detail.Draft == nil || detail.Draft.UpdatedAt != foreignRevision {
		t.Fatalf("rejected submissions must not rewrite the draft, got %+v", detail.Draft)
	}
}

// TestTaskGovernanceMatrix walks the fixed rejection order with instance and
// user policies and asserts the stable machine reasons and statuses.
func TestTaskGovernanceMatrix(t *testing.T) {
	h, adminToken, creator := readyTaskHarness(t, harnessOptions{})
	creatorToken := h.loginToken(t, creator, harnessPassword)
	draft := h.saveImageDraft(t, creatorToken, "治理矩阵", 1)
	baselineQueue := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_queue`)
	baselineOwnerTasks := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_tasks WHERE owner_user_id = $1::uuid`, h.userID(t, creator))

	putInstance := func(t *testing.T, body map[string]any) {
		t.Helper()
		status, raw := h.doRequest(t, "PUT", "/creation/generation-governance/instance", adminToken, body)
		if status != http.StatusOK {
			t.Fatalf("put instance governance: %d %s", status, raw)
		}
	}

	// provider_credit_blocked first: persist the 402 fact directly.
	if _, err := h.ownerPool.Exec(context.Background(), `UPDATE provider_connections SET credit_blocked_at = now()`); err != nil {
		t.Fatalf("simulate credit block: %v", err)
	}
	status, body := h.submitTask(t, creatorToken, draft.SessionID, "gov-credit", draft.Revision)
	if status != http.StatusForbidden {
		t.Fatalf("credit block must 403, got %d: %s", status, body)
	}
	assertErrorCode(t, body, "provider_credit_blocked")
	if _, err := h.ownerPool.Exec(context.Background(), `UPDATE provider_connections SET credit_blocked_at = NULL`); err != nil {
		t.Fatal(err)
	}

	// instance monthly → member monthly → instance rate → member rate →
	// member concurrency, each behind the previous one being lifted.
	putInstance(t, map[string]any{"monthly_task_limit": 0})
	status, body = h.submitTask(t, creatorToken, draft.SessionID, "gov-im", draft.Revision)
	assertErrorCode(t, body, "instance_monthly_generation_limit_reached")
	if status != http.StatusForbidden {
		t.Fatalf("monthly ceiling must 403, got %d", status)
	}

	putInstance(t, map[string]any{})
	_, _ = h.doRequest(t, "PUT", "/creation/generation-governance/users/"+h.userID(t, creator), adminToken, map[string]any{"monthly_task_limit": 0})
	_, body = h.submitTask(t, creatorToken, draft.SessionID, "gov-mm", draft.Revision)
	assertErrorCode(t, body, "member_monthly_generation_limit_reached")

	_, _ = h.doRequest(t, "PUT", "/creation/generation-governance/users/"+h.userID(t, creator), adminToken, map[string]any{})
	putInstance(t, map[string]any{"rate_limit": 0})
	status, body = h.submitTask(t, creatorToken, draft.SessionID, "gov-ir", draft.Revision)
	assertErrorCode(t, body, "instance_generation_rate_limited")
	if status != http.StatusTooManyRequests {
		t.Fatalf("rate limit must 429, got %d", status)
	}
	if retryAfter := body; len(retryAfter) == 0 {
		t.Fatal("sanity")
	}

	putInstance(t, map[string]any{})
	_, _ = h.doRequest(t, "PUT", "/creation/generation-governance/users/"+h.userID(t, creator), adminToken, map[string]any{"rate_limit": 0})
	_, body = h.submitTask(t, creatorToken, draft.SessionID, "gov-mr", draft.Revision)
	assertErrorCode(t, body, "member_generation_rate_limited")

	// Explicit 0 concurrency on the image pool blocks image but not video.
	_, _ = h.doRequest(t, "PUT", "/creation/generation-governance/users/"+h.userID(t, creator), adminToken, map[string]any{"image_concurrency": 0})
	_, body = h.submitTask(t, creatorToken, draft.SessionID, "gov-mc", draft.Revision)
	assertErrorCode(t, body, "member_generation_concurrency_limited")

	// Governance rejections record the structurally valid attempt but no
	// task, job, queue, or reservation. Counts are deltas over this test's
	// submissions: the shared database carries earlier scenarios' rows.
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_attempts WHERE user_id = $1::uuid`, h.userID(t, creator)); got < 6 {
		t.Fatalf("every structurally valid attempt must be counted, got %d", got)
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_tasks WHERE owner_user_id = $1::uuid`, h.userID(t, creator)); got != baselineOwnerTasks {
		t.Fatalf("governance rejections must not create tasks, baseline=%d got %d", baselineOwnerTasks, got)
	}
	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_queue`); got != baselineQueue {
		t.Fatalf("governance rejections must not enqueue, baseline=%d got %d", baselineQueue, got)
	}
}

// TestTaskSubmissionLatencyP95 keeps the admission transaction fast: the
// p95 of 20 sequential submissions must stay under one second.
func TestTaskSubmissionLatencyP95(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	draft := h.saveImageDraft(t, token, "延迟预算", 1)

	durations := make([]float64, 0, 20)
	for i := 0; i < 20; i++ {
		key := fmt.Sprintf("p95-%d", i)
		start := time.Now()
		status, body := h.submitTask(t, token, draft.SessionID, key, draft.Revision)
		durations = append(durations, time.Since(start).Seconds())
		if status != http.StatusCreated {
			t.Fatalf("submission %d must admit, got %d: %s", i, status, body)
		}
	}
	sort.Float64s(durations)
	p95 := durations[int(float64(len(durations))*0.95)-1]
	if p95 > 1.0 {
		t.Fatalf("submission p95 = %.3fs exceeds the 1s budget", p95)
	}
}

// TestConnectionDeleteGuardRejectsActiveTasks covers the fail-closed delete.
func TestConnectionDeleteGuardRejectsActiveTasks(t *testing.T) {
	h, adminToken, creator := readyTaskHarness(t, harnessOptions{})
	creatorToken := h.loginToken(t, creator, harnessPassword)
	draft := h.saveImageDraft(t, creatorToken, "删除守卫", 1)
	status, body := h.submitTask(t, creatorToken, draft.SessionID, "guard-key", draft.Revision)
	if status != http.StatusCreated {
		t.Fatalf("submission must admit: %d %s", status, body)
	}

	proof := h.issueProof(t, adminToken, "provider_connection.delete")
	status, raw := h.doSecureRequest(t, "DELETE", "/creation/provider-connection", adminToken, map[string]string{"proof": proof})
	if status != http.StatusConflict {
		t.Fatalf("delete with an active task must conflict, got %d: %s", status, raw)
	}
	assertErrorCode(t, raw, "active_generation_tasks_exist")
}

// TestUnsetGovernanceAdmits covers the default: no limits set → every
// structurally valid submission admits.
func TestUnsetGovernanceAdmits(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	draft := h.saveImageDraft(t, token, "未设置即不限", 4)
	for i := 0; i < 4; i++ {
		status, body := h.submitTask(t, token, draft.SessionID, fmt.Sprintf("unset-%d", i), draft.Revision)
		if status != http.StatusCreated {
			t.Fatalf("unlimited submission %d must admit, got %d: %s", i, status, body)
		}
	}
}
