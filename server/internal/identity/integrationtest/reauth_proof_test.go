// Reauthentication Proof commands (issue #154): issuance after current-
// password reverification, the trusted-HTTPS transport requirement, the
// closed exact-action set, single-use fail-closed consumption with issuer
// binding, the shared login limiter, and the reclaiming sweep — all observed
// through the Module's HTTP surface against real PostgreSQL, with every
// response asserted against the documented contract.
package integrationtest

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// issueReauthProofResponse mirrors the issuance success body.
type issueReauthProofResponse struct {
	Proof     string    `json:"proof"`
	Action    string    `json:"action"`
	ExpiresAt time.Time `json:"expires_at"`
}

// consumeReauthProofResponse mirrors the consumption success body.
type consumeReauthProofResponse struct {
	Status     string    `json:"status"`
	Action     string    `json:"action"`
	ConsumedAt time.Time `json:"consumed_at"`
}

// reauthErrorBody is the command error envelope.
type reauthErrorBody struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

// doReauthJSON posts one reauth command with the caller's session and — when
// proxyTrusted is set — the exact X-Forwarded-Proto: https marker the official
// private proxy writes (issue #152), standing in for the Compose edge exactly
// as the conformance surface requires.
func doReauthJSON(t *testing.T, handler http.Handler, path, token string, body []byte, proxyTrusted bool) (int, []byte, http.Header) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if proxyTrusted {
		req.Header.Set("X-Forwarded-Proto", "https")
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes(), rec.Header()
}

// postIssueProof issues one proof for the action with the given password.
func postIssueProof(t *testing.T, handler http.Handler, token, action, password string, proxyTrusted bool) (int, []byte, http.Header, issueReauthProofResponse) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"action": action, "password": password})
	status, raw, headers := doReauthJSON(t, handler, "/identity/admin/reauth/proofs", token, body, proxyTrusted)
	var decoded issueReauthProofResponse
	if status == http.StatusOK {
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("issue proof 200 body is not the success shape: %v (%s)", err, raw)
		}
	}
	return status, raw, headers, decoded
}

// postConsumeProof presents one proof for the action.
func postConsumeProof(t *testing.T, handler http.Handler, token, proof, action string, proxyTrusted bool) (int, []byte, consumeReauthProofResponse) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"proof": proof, "action": action})
	status, raw, _ := doReauthJSON(t, handler, "/identity/admin/reauth/proofs/consume", token, body, proxyTrusted)
	var decoded consumeReauthProofResponse
	if status == http.StatusOK {
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("consume proof 200 body is not the success shape: %v (%s)", err, raw)
		}
	}
	return status, raw, decoded
}

// decodeReauthError reads the machine code from an error body.
func decodeReauthError(t *testing.T, raw []byte) string {
	t.Helper()
	var decoded reauthErrorBody
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("error body is not the envelope shape: %v (%s)", err, raw)
	}
	return decoded.Error
}

func TestIssueReauthProofAdmitsOnlyActiveAdminsWithTheCurrentPassword(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)
	adminID := h.userIDByEmail(t, "admin@nevix.test")

	// Unauthenticated: the guard rejects before any reverification.
	status, raw, _, _ := postIssueProof(t, handler, "", "provider_connection.create", "admin-password-1", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs", status, raw)
	if status != http.StatusUnauthorized || decodeReauthError(t, raw) != "unauthorized" {
		t.Fatalf("unauthenticated issue: status %d body %s", status, raw)
	}

	// A member session never passes RequireAdmin.
	h.insertUser(t, "member@nevix.test", "member-password-1", "member", "active", false)
	_, _, memberLogin := doLogin(t, handler, "member@nevix.test", "member-password-1")
	status, raw, _, _ = postIssueProof(t, handler, memberLogin.Token, "provider_connection.create", "member-password-1", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs", status, raw)
	if status != http.StatusForbidden || decodeReauthError(t, raw) != "forbidden" {
		t.Fatalf("member issue: status %d body %s", status, raw)
	}

	// A disabled admin's session dies with the account: the guard answers
	// 401 before the command runs.
	if _, err := h.fixturePool.Exec(ctx, `UPDATE public.users SET status = 'disabled' WHERE id = $1`, adminID); err != nil {
		t.Fatalf("disable the fixture admin: %v", err)
	}
	status, raw, _, _ = postIssueProof(t, handler, adminToken, "provider_connection.create", "admin-password-1", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs", status, raw)
	if status != http.StatusUnauthorized {
		t.Fatalf("disabled-admin issue: status %d body %s, want 401", status, raw)
	}
	// A wrong current password fails like login: uniform 401. The admin is
	// re-enabled first so the observation isolates the credential check.
	if _, err := h.fixturePool.Exec(ctx, `UPDATE public.users SET status = 'active' WHERE id = $1`, adminID); err != nil {
		t.Fatalf("re-enable the fixture admin: %v", err)
	}
	status, raw, _, _ = postIssueProof(t, handler, adminToken, "provider_connection.create", "wrong-password-1", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs", status, raw)
	if status != http.StatusUnauthorized || decodeReauthError(t, raw) != "invalid_credentials" {
		t.Fatalf("wrong-password issue: status %d body %s", status, raw)
	}

	// Revoked sessions are equally dead.
	h.insertUser(t, "second@nevix.test", "second-password-1", "admin", "active", false)
	_, _, secondLogin := doLogin(t, handler, "second@nevix.test", "second-password-1")
	if status, raw := doLogout(t, handler, secondLogin.Token); status != http.StatusOK {
		t.Fatalf("logout: status %d body %s", status, raw)
	}
	status, raw, _, _ = postIssueProof(t, handler, secondLogin.Token, "provider_connection.create", "second-password-1", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs", status, raw)
	if status != http.StatusUnauthorized {
		t.Fatalf("revoked-session issue: status %d body %s, want 401", status, raw)
	}
}

func TestReauthProofEndpointsRequireProvenHTTPSTransport(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)

	// Without the proxy marker, issuance answers secure_transport_required
	// before any password work.
	status, raw, _, _ := postIssueProof(t, handler, adminToken, "provider_connection.create", "admin-password-1", false)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs", status, raw)
	if status != http.StatusBadRequest || decodeReauthError(t, raw) != "secure_transport_required" {
		t.Fatalf("insecure issue: status %d body %s", status, raw)
	}

	// A spoofed or plaintext marker value is not proof either.
	body, _ := json.Marshal(map[string]string{"action": "provider_connection.create", "password": "admin-password-1"})
	status, raw, _ = doReauthJSON(t, handler, "/identity/admin/reauth/proofs", adminToken, body, false)
	if status != http.StatusBadRequest {
		t.Fatalf("sanity: marker-less request unexpectedly reached %d", status)
	}
	req := httptest.NewRequest(http.MethodPost, "/identity/admin/reauth/proofs", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+adminToken)
	req.Header.Set("X-Forwarded-Proto", "http")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs", rec.Code, rec.Body.Bytes())
	if rec.Code != http.StatusBadRequest || decodeReauthError(t, rec.Body.Bytes()) != "secure_transport_required" {
		t.Fatalf("plaintext-marker issue: status %d body %s", rec.Code, rec.Body.String())
	}

	// Nothing was persisted by the refused attempts.
	var proofs int
	if err := h.fixturePool.QueryRow(ctx, `SELECT count(*) FROM public.reauth_proofs`).Scan(&proofs); err != nil {
		t.Fatalf("count proofs: %v", err)
	}
	if proofs != 0 {
		t.Fatalf("refused issuance persisted %d proof rows", proofs)
	}

	// Consumption demands the same proof, even for a valid token.
	status, raw, _, issued := postIssueProof(t, handler, adminToken, "provider_connection.create", "admin-password-1", true)
	if status != http.StatusOK {
		t.Fatalf("trusted-marker issue: status %d body %s", status, raw)
	}
	status, raw, _ = postConsumeProof(t, handler, adminToken, issued.Proof, "provider_connection.create", false)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs/consume", status, raw)
	if status != http.StatusBadRequest || decodeReauthError(t, raw) != "secure_transport_required" {
		t.Fatalf("insecure consume: status %d body %s", status, raw)
	}

	// With the marker, consumption proceeds — the refusal burned nothing.
	status, raw, consumed := postConsumeProof(t, handler, adminToken, issued.Proof, "provider_connection.create", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs/consume", status, raw)
	if status != http.StatusOK || consumed.Status != "consumed" {
		t.Fatalf("trusted consume: status %d body %s", status, raw)
	}
}

func TestIssueReauthProofValidatesTheClosedActionSet(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	_, handler, adminToken := governanceReady(t, ctx)

	for _, action := range []string{"provider_connection.create", "provider_connection.replace", "provider_connection.delete"} {
		status, raw, _, _ := postIssueProof(t, handler, adminToken, action, "admin-password-1", true)
		assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs", status, raw)
		if status != http.StatusOK {
			t.Fatalf("closed-set action %s: status %d body %s", action, status, raw)
		}
	}

	// An action outside the closed set is a shape failure; nothing else runs.
	status, raw, _, _ := postIssueProof(t, handler, adminToken, "user.delete", "admin-password-1", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs", status, raw)
	if status != http.StatusBadRequest || decodeReauthError(t, raw) != "invalid_action" {
		t.Fatalf("unknown action: status %d body %s", status, raw)
	}

	// A body missing the password field is a shape failure, not a
	// credential failure.
	body, _ := json.Marshal(map[string]string{"action": "provider_connection.create"})
	status, raw, _ = doReauthJSON(t, handler, "/identity/admin/reauth/proofs", adminToken, body, true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs", status, raw)
	if status != http.StatusBadRequest || decodeReauthError(t, raw) != "invalid_request" {
		t.Fatalf("missing password: status %d body %s", status, raw)
	}
}

func TestReauthProofLifecycleStoresHashWritesAuditAndConsumesOnce(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)
	adminID := h.userIDByEmail(t, "admin@nevix.test")

	status, raw, _, issued := postIssueProof(t, handler, adminToken, "provider_connection.replace", "admin-password-1", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs", status, raw)
	if status != http.StatusOK {
		t.Fatalf("issue: status %d body %s", status, raw)
	}
	if issued.Action != "provider_connection.replace" || issued.Proof == "" {
		t.Fatalf("issue body = %+v, want the proof and the bound action", issued)
	}
	window := time.Until(issued.ExpiresAt)
	if window <= 0 || window > 5*time.Minute+5*time.Second {
		t.Fatalf("expiry window = %v, want the fixed five minutes", window)
	}

	// Storage: only the SHA-256 hash of the body, bound to the issuer.
	digest := sha256.Sum256([]byte(issued.Proof))
	var rows int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM public.reauth_proofs WHERE token_hash = $1 AND user_id = $2 AND action = 'provider_connection.replace' AND consumed_at IS NULL`,
		digest[:], adminID,
	).Scan(&rows); err != nil {
		t.Fatalf("read proof row: %v", err)
	}
	if rows != 1 {
		t.Fatalf("proof row by hash = %d, want exactly 1", rows)
	}
	var plaintext int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM public.reauth_proofs WHERE token_hash <> $1`, digest[:],
	).Scan(&plaintext); err != nil {
		t.Fatalf("scan for foreign hashes: %v", err)
	}
	if plaintext != 0 {
		t.Fatal("unexpected extra proof rows")
	}

	// Audit: issuance and consumption both name the action and the admin,
	// from their own commits.
	actorID, _, _, _, metadata := h.latestAuditEntry(t, "reauth_proof_issued")
	if actorID != adminID || metadata["action"] != "provider_connection.replace" {
		t.Fatalf("reauth_proof_issued audit = actor %s metadata %v, want the admin and the action", actorID, metadata)
	}

	// A mismatched action is refused without burning the proof.
	status, raw, _ = postConsumeProof(t, handler, adminToken, issued.Proof, "provider_connection.delete", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs/consume", status, raw)
	if status != http.StatusConflict || decodeReauthError(t, raw) != "reauth_proof_action_mismatch" {
		t.Fatalf("mismatched consume: status %d body %s", status, raw)
	}

	// The bound action consumes exactly once.
	status, raw, consumed := postConsumeProof(t, handler, adminToken, issued.Proof, "provider_connection.replace", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs/consume", status, raw)
	if status != http.StatusOK || consumed.Status != "consumed" || consumed.Action != "provider_connection.replace" || consumed.ConsumedAt.IsZero() {
		t.Fatalf("consume: status %d body %s", status, raw)
	}
	actorID, _, _, _, metadata = h.latestAuditEntry(t, "reauth_proof_consumed")
	if actorID != adminID || metadata["action"] != "provider_connection.replace" {
		t.Fatalf("reauth_proof_consumed audit = actor %s metadata %v, want the admin and the action", actorID, metadata)
	}

	// Every later presentation — even with the right action — answers
	// already-consumed: the transition never restores.
	status, raw, _ = postConsumeProof(t, handler, adminToken, issued.Proof, "provider_connection.replace", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs/consume", status, raw)
	if status != http.StatusConflict || decodeReauthError(t, raw) != "reauth_proof_already_consumed" {
		t.Fatalf("second consume: status %d body %s", status, raw)
	}
	status, raw, _ = postConsumeProof(t, handler, adminToken, issued.Proof, "provider_connection.delete", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs/consume", status, raw)
	if status != http.StatusConflict || decodeReauthError(t, raw) != "reauth_proof_already_consumed" {
		t.Fatalf("post-consumption mismatch: status %d body %s, want already-consumed to dominate", status, raw)
	}
}

func TestConsumeReauthProofFailsClosedOnUnknownExpiredAndForeignProofs(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)

	// Unknown token.
	status, raw, _ := postConsumeProof(t, handler, adminToken, "not-a-proof", "provider_connection.create", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs/consume", status, raw)
	if status != http.StatusBadRequest || decodeReauthError(t, raw) != "reauth_proof_invalid" {
		t.Fatalf("unknown consume: status %d body %s", status, raw)
	}

	// Expired window: the fixture ages the row past its five minutes.
	_, _, _, issued := postIssueProof(t, handler, adminToken, "provider_connection.create", "admin-password-1", true)
	digest := sha256.Sum256([]byte(issued.Proof))
	if _, err := h.fixturePool.Exec(ctx,
		`UPDATE public.reauth_proofs SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, digest[:],
	); err != nil {
		t.Fatalf("age out the proof: %v", err)
	}
	status, raw, _ = postConsumeProof(t, handler, adminToken, issued.Proof, "provider_connection.create", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs/consume", status, raw)
	if status != http.StatusGone || decodeReauthError(t, raw) != "reauth_proof_expired" {
		t.Fatalf("expired consume: status %d body %s", status, raw)
	}

	// Issuer binding: another admin's session cannot spend this admin's
	// proof, and the answer is the uniform invalid.
	h.insertUser(t, "other@nevix.test", "other-password-1", "admin", "active", false)
	_, _, otherLogin := doLogin(t, handler, "other@nevix.test", "other-password-1")
	_, _, _, foreign := postIssueProof(t, handler, adminToken, "provider_connection.delete", "admin-password-1", true)
	status, raw, _ = postConsumeProof(t, handler, otherLogin.Token, foreign.Proof, "provider_connection.delete", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs/consume", status, raw)
	if status != http.StatusBadRequest || decodeReauthError(t, raw) != "reauth_proof_invalid" {
		t.Fatalf("foreign consume: status %d body %s", status, raw)
	}

	// Member sessions never reach the command.
	h.insertUser(t, "member@nevix.test", "member-password-1", "member", "active", false)
	_, _, memberLogin := doLogin(t, handler, "member@nevix.test", "member-password-1")
	status, raw, _ = postConsumeProof(t, handler, memberLogin.Token, issued.Proof, "provider_connection.create", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs/consume", status, raw)
	if status != http.StatusForbidden {
		t.Fatalf("member consume: status %d body %s, want 403", status, raw)
	}
}

func TestIssueReauthProofSharesTheLoginFailureLimiter(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	_, handler, adminToken := governanceReady(t, ctx)

	// Five failed reverifications lock the email — the same credential, the
	// same per-email window as login.
	for i := 0; i < 5; i++ {
		status, raw, _, _ := postIssueProof(t, handler, adminToken, "provider_connection.create", "wrong-password-1", true)
		assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs", status, raw)
		if status != http.StatusUnauthorized {
			t.Fatalf("failure %d: status %d body %s, want 401", i+1, status, raw)
		}
	}
	status, raw, headers, _ := postIssueProof(t, handler, adminToken, "provider_connection.create", "admin-password-1", true)
	assertContractResponse(t, http.MethodPost, "/identity/admin/reauth/proofs", status, raw)
	if status != http.StatusTooManyRequests || decodeReauthError(t, raw) != "login_rate_limited" {
		t.Fatalf("locked issue: status %d body %s", status, raw)
	}
	if headers.Get("Retry-After") == "" {
		t.Fatal("locked issue omitted Retry-After; clients branch on it")
	}

	// The lock is the login lock: the same email cannot log in either.
	status, raw, _ = doLogin(t, handler, "admin@nevix.test", "admin-password-1")
	assertContractResponse(t, http.MethodPost, "/identity/auth/login", status, raw)
	if status != http.StatusTooManyRequests {
		t.Fatalf("login after proof lockout: status %d body %s, want the shared 429", status, raw)
	}
}

func TestReauthProofSweepReclaimsExpiredRows(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)
	h.insertUser(t, "admin@nevix.test", "admin-password-1", "admin", "active", false)
	m, handler := h.moduleWithConfig(t, h.cfg)
	_, _, login := doLogin(t, handler, "admin@nevix.test", "admin-password-1")

	// One live proof and one expired fixture row: the sweep must reclaim
	// only the expired one.
	status, raw, _, issued := postIssueProof(t, handler, login.Token, "provider_connection.create", "admin-password-1", true)
	if status != http.StatusOK {
		t.Fatalf("issue: status %d body %s", status, raw)
	}
	digest := sha256.Sum256([]byte("swept-fixture-proof"))
	if _, err := h.fixturePool.Exec(ctx,
		`INSERT INTO public.reauth_proofs (user_id, action, token_hash, expires_at) VALUES ((SELECT id FROM public.users WHERE email = 'admin@nevix.test'), 'provider_connection.create', $1, now() - interval '1 second')`,
		digest[:],
	); err != nil {
		t.Fatalf("insert expired fixture: %v", err)
	}

	h.startWorkers(t, m) // RunWorkers sweeps immediately, then once per day

	deadline := time.Now().Add(15 * time.Second)
	for {
		var remaining int
		if err := h.fixturePool.QueryRow(ctx,
			`SELECT count(*) FROM public.reauth_proofs WHERE token_hash = $1`, digest[:],
		).Scan(&remaining); err != nil {
			t.Fatalf("count expired fixture: %v", err)
		}
		if remaining == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("expired proof row was not reclaimed within 15s of the sweep start")
		}
		time.Sleep(200 * time.Millisecond)
	}

	// The live window's row survives; expiry stays a consumption-time fact.
	live := sha256.Sum256([]byte(issued.Proof))
	var survived int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM public.reauth_proofs WHERE token_hash = $1`, live[:],
	).Scan(&survived); err != nil {
		t.Fatalf("count live proof: %v", err)
	}
	if survived != 1 {
		t.Fatal("sweep removed a proof inside its five-minute window")
	}
}
