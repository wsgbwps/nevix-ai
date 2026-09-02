package integrationtest

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
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

	draft := h.imageTaskIntent(t, token, "一张干净的白色背景商拍图", 3)

	// Attempts are governance rows scoped by user and persist across the
	// shared database's scenarios, so the assertions below count only this
	// creator's delta — one row per submission, none for a replay.
	attemptsBaseline := countRows(t, h.ownerPool,
		`SELECT count(*) FROM creation_generation_attempts WHERE user_id = $1::uuid`, h.userID(t, creator))

	status, body := h.submitTask(t, token, "key-once", draft)
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
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_attempts WHERE user_id = $1::uuid`, h.userID(t, creator)) != attemptsBaseline+1 {
		t.Fatal("admission must record exactly one structurally valid attempt")
	}
	// Idempotent replay: same key + same payload → the same task, nothing
	// counted twice.
	status, body = h.submitTask(t, token, "key-once", draft)
	if status != http.StatusOK {
		t.Fatalf("replay must answer 200, got %d: %s", status, body)
	}
	replayed := decodeTaskView(t, body)
	if replayed.Task.ID != taskID {
		t.Fatalf("replay must return the original task, got %s", replayed.Task.ID)
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_attempts WHERE user_id = $1::uuid`, h.userID(t, creator)) != attemptsBaseline+1 {
		t.Fatal("a replayed submission must not count a second attempt")
	}
	// Task/reservation counts scope to this scenario: other integration
	// scenarios legitimately own tasks in the same shared database.
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_tasks WHERE session_id = $1::uuid`, draft.SessionID) != 1 {
		t.Fatal("a replayed submission must not create a second task")
	}

	// Same key, different payload (prompt changed → different frozen spec).
	changed := h.buildTaskIntent(t, token, draft.SessionID, taskIntent{
		MediaType: "image", Model: "doubao-seedream-5.0-pro", Mode: "text-to-image",
		Ratio: "1:1", Resolution: "2K", Quantity: 3, Prompt: "另一个意图",
	})
	status, body = h.submitTask(t, token, "key-once", changed)
	if status != http.StatusConflict {
		t.Fatalf("same key different payload must conflict, got %d: %s", status, body)
	}
	assertErrorCode(t, body, "idempotency_payload_conflict")

	// Network retry on a fresh key creates exactly one additional task.
	status, body = h.submitTask(t, token, "key-two", changed)
	if status != http.StatusCreated {
		t.Fatalf("second key must admit, got %d: %s", status, body)
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_tasks WHERE session_id = $1::uuid`, draft.SessionID) != 2 {
		t.Fatal("a fresh key must create a new task")
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_reservations WHERE released_at IS NULL AND task_id = ANY (SELECT id FROM creation_generation_tasks WHERE session_id = $1::uuid)`, draft.SessionID) != 2 {
		t.Fatal("each admitted task owns exactly one active reservation")
	}
}

// TestTaskAdmissionRejectsIntentPayloads covers the intent-payload
// rejections: incomplete intent, foreign manifest version, values outside the
// current manifest, and references that violate the structural envelope or the
// session's material facts. Nothing is created on any rejection.
func TestTaskAdmissionRejectsIntentPayloads(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	intent := h.imageTaskIntent(t, token, "校验用意图", 1)
	before := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_tasks`)

	// An intent without a prompt cannot form a generation intent.
	emptyPrompt := intent
	emptyPrompt.Prompt = ""
	if status, body := h.submitTask(t, token, "noprompt-key", emptyPrompt); status != http.StatusUnprocessableEntity {
		t.Fatalf("promptless intent must be intent_not_ready, got %d: %s", status, body)
	} else {
		assertErrorCode(t, body, "intent_not_ready")
	}

	// An intent recorded against a foreign manifest version never freezes.
	foreignVersion := intent
	foreignVersion.ManifestVersion = 99
	if status, body := h.submitTask(t, token, "stale-key", foreignVersion); status != http.StatusUnprocessableEntity {
		t.Fatalf("foreign manifest version must be rejected, got %d: %s", status, body)
	} else {
		assertErrorCode(t, body, "media_unavailable")
	}

	// Values the current manifest no longer publishes are stale at admission.
	removedModel := intent
	removedModel.Model = "removed-legacy-model"
	if status, body := h.submitTask(t, token, "stale-model-key", removedModel); status != http.StatusUnprocessableEntity {
		t.Fatalf("removed model must be capability_stale, got %d: %s", status, body)
	} else {
		assertErrorCode(t, body, "capability_stale")
	}

	// Structural envelope violations are request rejections: unknown media,
	// out-of-range quantity, and an over-long prompt.
	badMedia := intent
	badMedia.MediaType = "audio"
	if status, body := h.submitTask(t, token, "badmedia-key", badMedia); status != http.StatusBadRequest {
		t.Fatalf("unknown media type must be invalid_request, got %d: %s", status, body)
	} else {
		assertErrorCode(t, body, "invalid_request")
	}
	badQuantity := intent
	badQuantity.Quantity = 5
	if status, body := h.submitTask(t, token, "badqty-key", badQuantity); status != http.StatusBadRequest {
		t.Fatalf("out-of-range quantity must be invalid_request, got %d: %s", status, body)
	} else {
		assertErrorCode(t, body, "invalid_request")
	}
	longPrompt := intent
	longPrompt.Prompt = strings.Repeat("啊", 2001)
	if status, body := h.submitTask(t, token, "longprompt-key", longPrompt); status != http.StatusBadRequest {
		t.Fatalf("over-long prompt must be invalid_request, got %d: %s", status, body)
	} else {
		assertErrorCode(t, body, "invalid_request")
	}
	// The 2000-rune boundary stays legal.
	boundary := intent
	boundary.Prompt = strings.Repeat("啊", 2000)
	if status, body := h.submitTask(t, token, "boundary-key", boundary); status != http.StatusCreated {
		t.Fatalf("2000-rune prompt must admit, got %d: %s", status, body)
	}

	// A reference to another session's material violates the envelope. The
	// mode must accept references so the check reaches the material facts
	// instead of failing earlier on the count envelope.
	other := h.imageTaskIntent(t, token, "他人素材会话", 1)
	foreignMaterial := h.uploadImage(t, token, other.SessionID, "foreign.png")
	foreignRefs := intent
	foreignRefs.Mode = "reference-image"
	foreignRefs.References = []any{map[string]any{"material_id": foreignMaterial, "role": "reference"}}
	if status, body := h.submitTask(t, token, "foreignref-key", foreignRefs); status != http.StatusBadRequest {
		t.Fatalf("foreign material reference must be invalid_request, got %d: %s", status, body)
	} else {
		assertErrorCode(t, body, "invalid_request")
	}

	// A role that cannot structurally accept the material's kind never freezes.
	ownAudio := h.uploadAudio(t, token, intent.SessionID)
	mismatched := intent
	mismatched.Mode = "reference-image"
	mismatched.References = []any{map[string]any{"material_id": ownAudio, "role": "reference"}}
	if status, body := h.submitTask(t, token, "rolekind-key", mismatched); status != http.StatusBadRequest {
		t.Fatalf("role-kind mismatch must be invalid_request, got %d: %s", status, body)
	} else {
		assertErrorCode(t, body, "invalid_request")
	}

	if got := countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_tasks`); got != before+1 {
		t.Fatalf("only the boundary submission may create a task, before=%d after=%d", before, got)
	}
}

// TestTaskAdmissionEnforcesPerModelReferenceCeiling: the reference-image
// count envelope is per model (pro 10, base 14, user-confirmed 2026-09-01).
// The same eleven-reference draft is stale on the pro model and admits on
// the base model; the base model admits exactly fourteen, and the draft's
// structural envelope refuses anything beyond the widest vendor bound.
func TestTaskAdmissionEnforcesPerModelReferenceCeiling(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	status, body := h.doRequest(t, "POST", "/creation/sessions", token, map[string]any{"name": "ref-ceiling"})
	if status != http.StatusCreated {
		t.Fatalf("create session: status=%d body=%s", status, body)
	}
	sessionID := extractField(t, body, "id")

	eleven := make([]any, 0, 11)
	for i := 0; i < 11; i++ {
		status, body := h.doUpload(t, "POST", "/creation/sessions/"+sessionID+"/materials", token,
			fmt.Sprintf("ref-%02d.png", i), pngBytes(t))
		if status != http.StatusCreated {
			t.Fatalf("upload reference %d: status=%d body=%s", i, status, body)
		}
		eleven = append(eleven, map[string]any{"material_id": extractField(t, body, "id"), "role": "reference"})
	}
	saveWithRefs := func(model string, refs []any) taskIntent {
		return h.buildTaskIntent(t, token, sessionID, taskIntent{
			MediaType: "image", Model: model, Mode: "reference-image",
			Ratio: "1:1", Resolution: "2K", Quantity: 1, Prompt: "参考图生图",
			References: refs,
		})
	}

	status, body = h.submitTask(t, token, "pro-over-ceiling", saveWithRefs("doubao-seedream-5.0-pro", eleven))
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("11 references must be stale on pro (ceiling 10), got %d: %s", status, body)
	}
	assertErrorCode(t, body, "capability_stale")

	status, body = h.submitTask(t, token, "base-within-ceiling", saveWithRefs("doubao-seedream-5.0", eleven))
	if status != http.StatusCreated {
		t.Fatalf("11 references must admit on the base model (ceiling 14), got %d: %s", status, body)
	}

	threeMore := make([]any, 0, 3)
	for i := 0; i < 3; i++ {
		status, body := h.doUpload(t, "POST", "/creation/sessions/"+sessionID+"/materials", token,
			fmt.Sprintf("ref-%02d.png", 11+i), pngBytes(t))
		if status != http.StatusCreated {
			t.Fatalf("upload reference %d: status=%d body=%s", 11+i, status, body)
		}
		threeMore = append(threeMore, map[string]any{"material_id": extractField(t, body, "id"), "role": "reference"})
	}
	fourteenRefs := append(append([]any{}, eleven...), threeMore...)
	status, body = h.submitTask(t, token, "base-at-ceiling", saveWithRefs("doubao-seedream-5.0", fourteenRefs))
	if status != http.StatusCreated {
		t.Fatalf("14 references must admit on the base model (ceiling 14), got %d: %s", status, body)
	}

	// The intent's structural envelope is the widest vendor bound (14): a
	// fifteenth reference can never be submitted, whatever the model.
	status, body = h.doUpload(t, "POST", "/creation/sessions/"+sessionID+"/materials", token,
		"ref-14.png", pngBytes(t))
	if status != http.StatusCreated {
		t.Fatalf("upload reference 15: status=%d body=%s", status, body)
	}
	fifteenRefs := append(append([]any{}, fourteenRefs...),
		map[string]any{"material_id": extractField(t, body, "id"), "role": "reference"})
	status, body = h.submitTask(t, token, "fifteen-ref-key", saveWithRefs("doubao-seedream-5.0", fifteenRefs))
	if status != http.StatusBadRequest {
		t.Fatalf("a 15-reference intent must violate the structural envelope, got %d: %s", status, body)
	}
	assertErrorCode(t, body, "invalid_request")
}

// TestTaskGovernanceMatrix walks the fixed rejection order with instance and
// user policies and asserts the stable machine reasons and statuses.
func TestTaskGovernanceMatrix(t *testing.T) {
	h, adminToken, creator := readyTaskHarness(t, harnessOptions{})
	creatorToken := h.loginToken(t, creator, harnessPassword)
	draft := h.imageTaskIntent(t, creatorToken, "治理矩阵", 1)
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
	status, body := h.submitTask(t, creatorToken, "gov-credit", draft)
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
	status, body = h.submitTask(t, creatorToken, "gov-im", draft)
	assertErrorCode(t, body, "instance_monthly_generation_limit_reached")
	if status != http.StatusForbidden {
		t.Fatalf("monthly ceiling must 403, got %d", status)
	}

	putInstance(t, map[string]any{})
	_, _ = h.doRequest(t, "PUT", "/creation/generation-governance/users/"+h.userID(t, creator), adminToken, map[string]any{"monthly_task_limit": 0})
	_, body = h.submitTask(t, creatorToken, "gov-mm", draft)
	assertErrorCode(t, body, "member_monthly_generation_limit_reached")

	_, _ = h.doRequest(t, "PUT", "/creation/generation-governance/users/"+h.userID(t, creator), adminToken, map[string]any{})
	putInstance(t, map[string]any{"rate_limit": 0})
	status, body = h.submitTask(t, creatorToken, "gov-ir", draft)
	assertErrorCode(t, body, "instance_generation_rate_limited")
	if status != http.StatusTooManyRequests {
		t.Fatalf("rate limit must 429, got %d", status)
	}
	if retryAfter := body; len(retryAfter) == 0 {
		t.Fatal("sanity")
	}

	putInstance(t, map[string]any{})
	_, _ = h.doRequest(t, "PUT", "/creation/generation-governance/users/"+h.userID(t, creator), adminToken, map[string]any{"rate_limit": 0})
	_, body = h.submitTask(t, creatorToken, "gov-mr", draft)
	assertErrorCode(t, body, "member_generation_rate_limited")

	// Explicit 0 concurrency on the image pool blocks image but not video.
	_, _ = h.doRequest(t, "PUT", "/creation/generation-governance/users/"+h.userID(t, creator), adminToken, map[string]any{"image_concurrency": 0})
	_, body = h.submitTask(t, creatorToken, "gov-mc", draft)
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
	draft := h.imageTaskIntent(t, token, "延迟预算", 1)

	durations := make([]float64, 0, 20)
	for i := 0; i < 20; i++ {
		key := fmt.Sprintf("p95-%d", i)
		start := time.Now()
		status, body := h.submitTask(t, token, key, draft)
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
	draft := h.imageTaskIntent(t, creatorToken, "删除守卫", 1)
	status, body := h.submitTask(t, creatorToken, "guard-key", draft)
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
	draft := h.imageTaskIntent(t, token, "未设置即不限", 4)
	for i := 0; i < 4; i++ {
		status, body := h.submitTask(t, token, fmt.Sprintf("unset-%d", i), draft)
		if status != http.StatusCreated {
			t.Fatalf("unlimited submission %d must admit, got %d: %s", i, status, body)
		}
	}
}
