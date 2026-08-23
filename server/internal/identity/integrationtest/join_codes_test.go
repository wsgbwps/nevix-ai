// Join-code governance commands (issue #120): issue with an optional label,
// read the active plaintext codes, revoke. The active cap of three is
// enforced inside the create transaction; member and unauthenticated callers
// never pass the RequireAdmin guard; every write commits its audit row — all
// observed through the Module's HTTP surface against real PostgreSQL.
package integrationtest

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// joinCodeEntry mirrors the create/list response's code object.
type joinCodeEntry struct {
	ID        string    `json:"id"`
	Code      string    `json:"code"`
	Label     string    `json:"label"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
}

type joinCodeEnvelope struct {
	JoinCode joinCodeEntry `json:"join_code"`
}

type joinCodeListResponse struct {
	JoinCodes []joinCodeEntry `json:"join_codes"`
}

// createdJoinCode mirrors the create command's flat 201 body.
type createdJoinCode struct {
	ID        string    `json:"id"`
	Code      string    `json:"code"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"created_at"`
}

// createJoinCode issues one code with an optional label.
func createJoinCode(t *testing.T, handler http.Handler, token, label string) (int, []byte, createdJoinCode) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"label": label})
	status, raw := doJSON(t, handler, http.MethodPost, "/identity/admin/join-codes", token, body)
	var decoded createdJoinCode
	if status == http.StatusCreated {
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("create join code 201 body is not the flat entry shape: %v (%s)", err, raw)
		}
	}
	return status, raw, decoded
}

// listJoinCodes fetches the active set.
func listJoinCodes(t *testing.T, handler http.Handler, token string) (int, []byte, joinCodeListResponse) {
	t.Helper()
	status, raw := doAuthenticated(t, handler, http.MethodGet, "/identity/admin/join-codes", token)
	var decoded joinCodeListResponse
	if status == http.StatusOK {
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("list join codes 200 body is not the list shape: %v (%s)", err, raw)
		}
	}
	return status, raw, decoded
}

// revokeJoinCode revokes one code by id.
func revokeJoinCode(t *testing.T, handler http.Handler, token, joinCodeID string) (int, []byte) {
	t.Helper()
	return doAuthenticated(t, handler, http.MethodDelete, "/identity/admin/join-codes/"+joinCodeID, token)
}

// isCrockfordJoinCode reports whether the code is 8 Crockford base32
// characters: the digits and letters that survive being read aloud, with
// I, L, O, and U excluded by design.
func isCrockfordJoinCode(code string) bool {
	if len(code) != 8 {
		return false
	}
	for _, c := range code {
		if !strings.ContainsRune("0123456789ABCDEFGHJKMNPQRSTVWXYZ", c) {
			return false
		}
	}
	return true
}

func TestCreateJoinCodeReturnsPlaintextAndWritesAudit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)
	adminID := h.userIDByEmail(t, "admin@nevix.test")

	// Issue with a label: the plaintext comes back immediately in the flat
	// plan-frozen shape.
	status, raw, first := createJoinCode(t, handler, adminToken, "  市场群  ")
	assertContractResponse(t, http.MethodPost, "/identity/admin/join-codes", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("create join code: status %d body %s", status, raw)
	}
	if !isCrockfordJoinCode(first.Code) {
		t.Fatalf("issued code %q is not 8 Crockford base32 characters", first.Code)
	}
	if first.Label != "市场群" {
		t.Fatalf("label = %q, want the trimmed label", first.Label)
	}
	if first.CreatedAt.IsZero() {
		t.Fatal("created_at is zero; the response must carry the issue time")
	}

	// The audit row names the code and the label, from the same commit —
	// checked before the second create makes itself the latest row.
	actorID, _, targetID, _, metadata := h.latestAuditEntry(t, "join_code_created")
	if actorID != adminID {
		t.Fatalf("join_code_created actor = %s, want the issuing admin %s", actorID, adminID)
	}
	if targetID != nil {
		t.Fatalf("join_code_created target = %v, want none: a join code is not a user", *targetID)
	}
	if metadata["join_code_id"] != first.ID {
		t.Fatalf("join_code_created join_code_id = %q, want %q", metadata["join_code_id"], first.ID)
	}
	if metadata["label"] != "市场群" {
		t.Fatalf("join_code_created label = %q, want the issued label", metadata["label"])
	}

	// A second code without a label stores the empty string, not a null.
	status, raw, second := createJoinCode(t, handler, adminToken, "")
	assertContractResponse(t, http.MethodPost, "/identity/admin/join-codes", status, raw)
	if status != http.StatusCreated || second.Label != "" || second.Code == first.Code {
		t.Fatalf("second create: status %d label %q, want 201 with distinct code and empty label (body %s)", status, second.Label, raw)
	}

	// The list shows both plaintext codes, newest first.
	status, raw, list := listJoinCodes(t, handler, adminToken)
	assertContractResponse(t, http.MethodGet, "/identity/admin/join-codes", status, raw)
	if status != http.StatusOK || len(list.JoinCodes) != 2 {
		t.Fatalf("list after two creates: status %d len %d, want 2 (body %s)", status, len(list.JoinCodes), raw)
	}
	if list.JoinCodes[0].ID != second.ID || list.JoinCodes[1].ID != first.ID {
		t.Fatalf("list order = [%s, %s], want newest first", list.JoinCodes[0].ID, list.JoinCodes[1].ID)
	}
}

func TestActiveJoinCodeCapBlocksTheFourthCreateUntilRevoked(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	_, handler, adminToken := governanceReady(t, ctx)

	issued := []createdJoinCode{}
	for i := 0; i < 3; i++ {
		status, raw, entry := createJoinCode(t, handler, adminToken, "")
		assertContractResponse(t, http.MethodPost, "/identity/admin/join-codes", status, raw)
		if status != http.StatusCreated {
			t.Fatalf("create #%d: status %d body %s", i+1, status, raw)
		}
		issued = append(issued, entry)
	}

	// The fourth create is refused: three reusable codes cover every
	// onboarding wave, and the answer names the cap.
	status, raw, _ := createJoinCode(t, handler, adminToken, "")
	assertContractResponse(t, http.MethodPost, "/identity/admin/join-codes", status, raw)
	if status != http.StatusConflict || !contains(raw, "too_many_active_join_codes") {
		t.Fatalf("fourth create: status %d body %s, want 409 too_many_active_join_codes", status, raw)
	}

	status, raw, list := listJoinCodes(t, handler, adminToken)
	assertContractResponse(t, http.MethodGet, "/identity/admin/join-codes", status, raw)
	if status != http.StatusOK || len(list.JoinCodes) != 3 {
		t.Fatalf("list at cap: status %d len %d, want 3 (body %s)", status, len(list.JoinCodes), raw)
	}

	// Revoking frees the slot for the next wave.
	status, raw = revokeJoinCode(t, handler, adminToken, issued[0].ID)
	assertContractResponse(t, http.MethodDelete, "/identity/admin/join-codes/{joinCodeID}", status, raw)
	if status != http.StatusOK {
		t.Fatalf("revoke at cap: status %d body %s", status, raw)
	}
	status, raw, _ = createJoinCode(t, handler, adminToken, "")
	assertContractResponse(t, http.MethodPost, "/identity/admin/join-codes", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("create after revoke: status %d body %s, want 201", status, raw)
	}
	_, _, list = listJoinCodes(t, handler, adminToken)
	if len(list.JoinCodes) != 3 {
		t.Fatalf("list after revoke-and-recreate = %d entries, want 3", len(list.JoinCodes))
	}
}

func TestConcurrentCreatesCannotExceedTheActiveCap(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	_, handler, adminToken := governanceReady(t, ctx)

	// Two codes are active; four creates race for the single free slot. The
	// advisory lock inside the create transaction must serialize them: exactly
	// one 201, three 409, and the list still holds three codes — not four.
	for i := 0; i < 2; i++ {
		if status, raw, _ := createJoinCode(t, handler, adminToken, ""); status != http.StatusCreated {
			t.Fatalf("seed create #%d: status %d body %s", i+1, status, raw)
		}
	}

	const attempts = 4
	statuses := make([]int, attempts)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			status, _, _ := createJoinCode(t, handler, adminToken, "")
			statuses[i] = status
		}(i)
	}
	close(start)
	wg.Wait()

	created, refused := 0, 0
	for _, status := range statuses {
		switch status {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
			refused++
		default:
			t.Fatalf("concurrent create answered %d, want 201 or 409", status)
		}
	}
	if created != 1 || refused != attempts-1 {
		t.Fatalf("concurrent creates at cap: %d created / %d refused, want 1 / %d (statuses %v)", created, refused, attempts-1, statuses)
	}

	status, raw, list := listJoinCodes(t, handler, adminToken)
	assertContractResponse(t, http.MethodGet, "/identity/admin/join-codes", status, raw)
	if status != http.StatusOK || len(list.JoinCodes) != 3 {
		t.Fatalf("list after concurrent creates: status %d len %d, want exactly 3 at the cap (body %s)", status, len(list.JoinCodes), raw)
	}
}

func TestRevokeRemovesCodeFromListAndKeepsTheRow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)

	_, _, keeper := createJoinCode(t, handler, adminToken, "")
	_, _, doomed := createJoinCode(t, handler, adminToken, "旧渠道")

	status, raw := revokeJoinCode(t, handler, adminToken, doomed.ID)
	assertContractResponse(t, http.MethodDelete, "/identity/admin/join-codes/{joinCodeID}", status, raw)
	if status != http.StatusOK || !contains(raw, `"revoked"`) {
		t.Fatalf("revoke: status %d body %s, want 200 revoked", status, raw)
	}

	// The revoked code is gone from the active list; the keeper stays.
	status, raw, list := listJoinCodes(t, handler, adminToken)
	assertContractResponse(t, http.MethodGet, "/identity/admin/join-codes", status, raw)
	if status != http.StatusOK || len(list.JoinCodes) != 1 || list.JoinCodes[0].ID != keeper.ID {
		t.Fatalf("list after revoke: status %d entries %+v, want only the keeper (body %s)", status, list.JoinCodes, raw)
	}

	// The row itself survives as the audit-corroborating record.
	var revokedRows int
	if err := h.fixturePool.QueryRow(context.Background(),
		`SELECT count(*) FROM public.join_codes WHERE id = $1 AND revoked_at IS NOT NULL`, doomed.ID,
	).Scan(&revokedRows); err != nil {
		t.Fatalf("count revoked row: %v", err)
	}
	if revokedRows != 1 {
		t.Fatalf("revoked row count = %d, want 1: revocation must keep the row", revokedRows)
	}

	// Revocation is idempotent-terminal: the same id, an unknown id, and a
	// malformed id all answer the same 404 and never reach the database as
	// a second write.
	for _, id := range []string{doomed.ID, "00000000-0000-0000-0000-000000000000", "not-a-uuid"} {
		status, raw = revokeJoinCode(t, handler, adminToken, id)
		assertContractResponse(t, http.MethodDelete, "/identity/admin/join-codes/{joinCodeID}", status, raw)
		if status != http.StatusNotFound || !contains(raw, "join_code_not_found") {
			t.Fatalf("revoke %s: status %d body %s, want 404 join_code_not_found", id, status, raw)
		}
	}

	// The revocation audit row names the code, from the same commit.
	actorID, _, targetID, _, metadata := h.latestAuditEntry(t, "join_code_revoked")
	if actorID != h.userIDByEmail(t, "admin@nevix.test") {
		t.Fatalf("join_code_revoked actor = %s, want the revoking admin", actorID)
	}
	if targetID != nil {
		t.Fatalf("join_code_revoked target = %v, want none", *targetID)
	}
	if metadata["join_code_id"] != doomed.ID {
		t.Fatalf("join_code_revoked join_code_id = %q, want %q", metadata["join_code_id"], doomed.ID)
	}
}

func TestJoinCodeSurfaceIsAdminOnlyAndShapeChecked(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)
	h.insertUser(t, "member@nevix.test", "member-password-1", "member", "active", false)
	_, _, memberLogin := doLogin(t, handler, "member@nevix.test", "member-password-1")

	// A member is behind RequireAdmin on every join-code route. The observed
	// path matches the contract's segment shape, so the collection calls
	// assert against the collection path and the item call against the
	// parameterized one.
	for _, call := range []struct {
		name       string
		method     string
		path       string
		contractOn string
	}{
		{"create as member", http.MethodPost, "/identity/admin/join-codes", "/identity/admin/join-codes"},
		{"list as member", http.MethodGet, "/identity/admin/join-codes", "/identity/admin/join-codes"},
		{"revoke as member", http.MethodDelete, "/identity/admin/join-codes/00000000-0000-0000-0000-000000000000", "/identity/admin/join-codes/{joinCodeID}"},
	} {
		status, raw := doAuthenticated(t, handler, call.method, call.path, memberLogin.Token)
		assertContractResponse(t, call.method, call.contractOn, status, raw)
		if status != http.StatusForbidden || !contains(raw, `"forbidden"`) {
			t.Fatalf("%s: status %d body %s, want 403 forbidden", call.name, status, raw)
		}
	}

	// An unauthenticated caller never resolves a principal: 401 everywhere.
	for _, call := range []struct {
		name       string
		method     string
		path       string
		contractOn string
	}{
		{"create unauthenticated", http.MethodPost, "/identity/admin/join-codes", "/identity/admin/join-codes"},
		{"list unauthenticated", http.MethodGet, "/identity/admin/join-codes", "/identity/admin/join-codes"},
		{"revoke unauthenticated", http.MethodDelete, "/identity/admin/join-codes/00000000-0000-0000-0000-000000000000", "/identity/admin/join-codes/{joinCodeID}"},
	} {
		status, raw := doAuthenticated(t, handler, call.method, call.path, "")
		assertContractResponse(t, call.method, call.contractOn, status, raw)
		if status != http.StatusUnauthorized || !contains(raw, `"unauthorized"`) {
			t.Fatalf("%s: status %d body %s, want 401 unauthorized", call.name, status, raw)
		}
	}

	// Shape failures stay client-side: an over-long label never opens a
	// transaction.
	status, raw := doJSON(t, handler, http.MethodPost, "/identity/admin/join-codes", adminToken,
		[]byte(`{"label":"`+strings.Repeat("x", 129)+`"}`))
	assertContractResponse(t, http.MethodPost, "/identity/admin/join-codes", status, raw)
	if status != http.StatusBadRequest || !contains(raw, "invalid_label") {
		t.Fatalf("over-long label: status %d body %s, want 400 invalid_label", status, raw)
	}
}
