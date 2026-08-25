// Join-code self-registration (issue #121): redeeming an active code mints
// an active member with a session in one transaction; a wrong code, a
// revoked code, and a closed registration (no active codes) are one answer;
// email conflicts and per-email rate limiting behave per the contract — all
// observed through the Module's HTTP surface against real PostgreSQL, with
// the audit row asserted in the same committed state.
package integrationtest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// registerBody builds the register request shape.
func registerBody(email, password, joinCode, displayName string) []byte {
	body, _ := json.Marshal(map[string]string{
		"email":        email,
		"password":     password,
		"join_code":    joinCode,
		"display_name": displayName,
	})
	return body
}

// doRegister posts a self-registration and returns status and raw body.
func doRegister(t *testing.T, handler http.Handler, body []byte) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/identity/register", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

func TestRegisterWithActiveCodeCreatesMemberAndSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)

	_, _, code := createJoinCode(t, handler, adminToken, "市场群")

	status, raw := doRegister(t, handler, registerBody("New.Member@nevix.test", "self-chosen-pass-1", code.Code, "  New Member  "))
	assertContractResponse(t, http.MethodPost, "/identity/register", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("register: status %d body %s", status, raw)
	}
	var registered loginResponse
	if err := json.Unmarshal(raw, &registered); err != nil {
		t.Fatalf("register 201 body is not the login shape: %v (%s)", err, raw)
	}
	if registered.Token == "" || registered.ExpiresAt.IsZero() {
		t.Fatalf("register response lacks token/expires_at: %s", raw)
	}
	if registered.User.Role != "member" || registered.User.MustChangePassword {
		t.Fatalf("registered user = %s/mcp=%v, want member/false (body %s)", registered.User.Role, registered.User.MustChangePassword, raw)
	}
	if registered.User.Email != "new.member@nevix.test" || registered.User.DisplayName != "New Member" {
		t.Fatalf("registered email/display = %s/%s, want normalized email and trimmed name", registered.User.Email, registered.User.DisplayName)
	}

	// The account row is an active member with the first login stamped: the
	// account entered the application with the issued session, so the
	// never-logged-in deletion protection starts here.
	var role, accountStatus string
	var lastLoginAt *time.Time
	if err := h.fixturePool.QueryRow(context.Background(),
		`SELECT role, status, last_login_at FROM public.users WHERE id = $1`, registered.User.ID,
	).Scan(&role, &accountStatus, &lastLoginAt); err != nil {
		t.Fatalf("read registered account: %v", err)
	}
	if role != "member" || accountStatus != "active" || lastLoginAt == nil {
		t.Fatalf("registered account = %s/%s/last_login=%v, want member/active/stamped", role, accountStatus, lastLoginAt)
	}
	if got := h.sessionsForUser(t, registered.User.ID); got != 1 {
		t.Fatalf("registered account sessions = %d, want exactly the issued one", got)
	}

	// The issued session is stored only as its SHA-256 hash: the bearer
	// token exists once, in the response.
	digest := sha256.Sum256([]byte(registered.Token))
	var storedHash string
	if err := h.fixturePool.QueryRow(context.Background(),
		`SELECT encode(token_hash, 'hex') FROM public.sessions WHERE user_id = $1`, registered.User.ID,
	).Scan(&storedHash); err != nil {
		t.Fatalf("read stored registration token hash: %v", err)
	}
	if storedHash != hex.EncodeToString(digest[:]) {
		t.Fatal("stored registration session hash is not the SHA-256 of the issued token")
	}
	// Registration is one business command, so its audit trail is exactly
	// the setup's session_created + join_code_created plus one
	// user_self_registered — never an additional session_created for the
	// issued session.
	if actions := h.auditActions(t); len(actions) != 3 ||
		actions[0] != "session_created" || actions[1] != "join_code_created" || actions[2] != "user_self_registered" {
		t.Fatalf("audit actions after register = %v, want [session_created join_code_created user_self_registered] (no extra session_created)", actions)
	}

	// The issued session works on its very next request — the register
	// response is a working entry into the application, not a promise.
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", registered.Token); status != http.StatusOK {
		t.Fatalf("me with registered session: status %d body %s, want 200", status, body)
	}

	// The audit row commits with the registration: the actor is the new
	// member, the metadata names the email and the code redeemed.
	actorID, _, targetID, _, metadata := h.latestAuditEntry(t, "user_self_registered")
	if actorID != registered.User.ID {
		t.Fatalf("user_self_registered actor = %s, want the new member %s", actorID, registered.User.ID)
	}
	if targetID != nil {
		t.Fatalf("user_self_registered target = %v, want none: the actor is the subject", *targetID)
	}
	if metadata["email"] != "new.member@nevix.test" {
		t.Fatalf("user_self_registered metadata email = %q, want the registered email", metadata["email"])
	}
	if metadata["join_code_id"] != code.ID {
		t.Fatalf("user_self_registered join_code_id = %q, want %q", metadata["join_code_id"], code.ID)
	}

	// The code stays reusable: a second registration on the same code works.
	status, raw = doRegister(t, handler, registerBody("second.member@nevix.test", "another-self-pass-1", code.Code, ""))
	assertContractResponse(t, http.MethodPost, "/identity/register", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("second register on the same code: status %d body %s, want 201", status, raw)
	}
	var second loginResponse
	json.Unmarshal(raw, &second)
	if second.User.DisplayName != "second.member" {
		t.Fatalf("omitted display name = %q, want the email local part", second.User.DisplayName)
	}

	// A lowercase typing of a fresh code still redeems (Crockford base32 is
	// case-insensitive; the server canonicalizes before comparing).
	_, _, another := createJoinCode(t, handler, adminToken, "")
	lower := strings.ToLower(another.Code)
	if lower == another.Code {
		t.Fatalf("test setup: generated code %q has no lowercase form", another.Code)
	}
	status, raw = doRegister(t, handler, registerBody("third.member@nevix.test", "third-self-pass-1", lower, ""))
	assertContractResponse(t, http.MethodPost, "/identity/register", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("lowercase code register: status %d body %s, want 201", status, raw)
	}
}

func TestRegisterRollsBackAccountSessionAuditAndLastLoginTogether(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)
	_, _, code := createJoinCode(t, handler, adminToken, "")

	// A failure at the transaction's last participant — the audit write,
	// broken here by a fixture-installed trigger — rolls the whole
	// registration back: no member, no session, no last-login stamp, no
	// audit row.
	restore := h.failAuditWritesFor(t, "user_self_registered")
	status, raw := doRegister(t, handler, registerBody("rollback.member@nevix.test", "self-chosen-pass-1", code.Code, ""))
	assertContractResponse(t, http.MethodPost, "/identity/register", status, raw)
	if status != http.StatusInternalServerError || !contains(raw, "internal_error") {
		t.Fatalf("register with a broken audit sink: status %d body %s, want 500 internal_error", status, raw)
	}
	if got := h.countUsers(t); got != 1 {
		t.Fatalf("users after rolled-back register = %d, want only the admin", got)
	}
	if got := countSessions(t, h); got != 1 {
		t.Fatalf("sessions after rolled-back register = %d, want only the admin login session", got)
	}
	for _, action := range h.auditActions(t) {
		if action == "user_self_registered" {
			t.Fatal("a rolled-back registration left a user_self_registered audit row")
		}
	}

	// Repair the audit sink: the same registration now succeeds end to end,
	// so the earlier failure rolled everything back.
	restore()
	status, raw = doRegister(t, handler, registerBody("rollback.member@nevix.test", "self-chosen-pass-1", code.Code, ""))
	assertContractResponse(t, http.MethodPost, "/identity/register", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("register after audit repair: status %d body %s, want 201", status, raw)
	}
	var registered loginResponse
	if err := json.Unmarshal(raw, &registered); err != nil {
		t.Fatalf("repaired register body is not the login shape: %v (%s)", err, raw)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", registered.Token); status != http.StatusOK {
		t.Fatalf("me with the repaired registration session: status %d body %s, want 200", status, body)
	}
	if _, _, _, _, metadata := h.latestAuditEntry(t, "user_self_registered"); metadata["email"] != "rollback.member@nevix.test" {
		t.Fatalf("repaired registration audit metadata = %v, want the registered email", metadata)
	}
}

// TestRegisterHoldsTheJoinCodeRowLockUntilCommit: registration's code
// validation runs under the caller-owned FOR UPDATE row lock, so its
// decision holds until commit. A second database session holding that lock
// blocks the registration; when the holder revokes the code and commits
// first, the waiting registration finds the door closed and nothing is
// persisted.
func TestRegisterHoldsTheJoinCodeRowLockUntilCommit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)
	_, _, code := createJoinCode(t, handler, adminToken, "")

	conn, err := h.fixturePool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire fixture connection: %v", err)
	}
	t.Cleanup(conn.Release)
	blocker, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin blocker transaction: %v", err)
	}
	if _, err := blocker.Exec(ctx,
		`SELECT id FROM public.join_codes WHERE code = $1 FOR UPDATE`, code.Code,
	); err != nil {
		t.Fatalf("hold the code row lock: %v", err)
	}

	type outcome struct {
		status int
		body   []byte
	}
	done := make(chan outcome, 1)
	go func() {
		status, body := doRegister(t, handler, registerBody("locked.member@nevix.test", "self-chosen-pass-1", code.Code, ""))
		done <- outcome{status: status, body: body}
	}()

	// The registration must wait behind the holder, not proceed on an
	// unlocked validation.
	select {
	case <-done:
		t.Fatal("registration completed while another transaction held the join-code row lock")
	case <-time.After(1500 * time.Millisecond):
	}

	// The holder revokes and commits first: the blocked registration then
	// re-reads the row under its own lock and answers the uniform closed
	// door — no member, no session, no audit row.
	if _, err := blocker.Exec(ctx,
		`UPDATE public.join_codes SET revoked_at = now() WHERE code = $1`, code.Code,
	); err != nil {
		t.Fatalf("revoke the code inside the blocker: %v", err)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatalf("commit the blocker: %v", err)
	}

	select {
	case out := <-done:
		if out.status != http.StatusForbidden || !contains(out.body, "invalid_join_code") {
			t.Fatalf("register after the racing revocation committed: status %d body %s, want 403 invalid_join_code", out.status, out.body)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("registration did not finish after the lock holder committed")
	}
	if got := h.countUsers(t); got != 1 {
		t.Fatalf("users after the lock-lost registration = %d, want only the admin", got)
	}
	for _, action := range h.auditActions(t) {
		if action == "user_self_registered" {
			t.Fatal("the lock-lost registration wrote a user_self_registered audit row")
		}
	}
}

func TestRegisterAnswersWrongCodeAndClosedRegistrationIdentically(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)

	// A live code exists for the wrong-code attempt: the deployment is open,
	// only the submitted code is wrong.
	_, _, code := createJoinCode(t, handler, adminToken, "")

	wrongStatus, wrongBody := doRegister(t, handler, registerBody("wrong@nevix.test", "some-self-pass-1", "00000000", ""))
	assertContractResponse(t, http.MethodPost, "/identity/register", wrongStatus, wrongBody)
	if wrongStatus != http.StatusForbidden || !contains(wrongBody, "invalid_join_code") {
		t.Fatalf("wrong code: status %d body %s, want 403 invalid_join_code", wrongStatus, wrongBody)
	}

	// Revoke every code: registration is closed, and the closed answer is
	// byte-identical to the wrong-code answer — no enumeration surface.
	status, raw := revokeJoinCode(t, handler, adminToken, code.ID)
	if status != http.StatusOK {
		t.Fatalf("revoke setup: status %d body %s", status, raw)
	}
	closedStatus, closedBody := doRegister(t, handler, registerBody("closed@nevix.test", "some-self-pass-1", "00000000", ""))
	assertContractResponse(t, http.MethodPost, "/identity/register", closedStatus, closedBody)
	if closedStatus != wrongStatus {
		t.Fatalf("closed registration status %d, want the wrong-code status %d", closedStatus, wrongStatus)
	}
	if string(closedBody) != string(wrongBody) {
		t.Fatalf("closed registration body %s, want byte-identical to the wrong-code body %s", closedBody, wrongBody)
	}

	// A revoked code's own plaintext is equally dead: redemption of the exact
	// issued string is the same forbidden answer.
	closedStatus, closedBody = doRegister(t, handler, registerBody("closed@nevix.test", "some-self-pass-1", code.Code, ""))
	assertContractResponse(t, http.MethodPost, "/identity/register", closedStatus, closedBody)
	if closedStatus != http.StatusForbidden || !contains(closedBody, "invalid_join_code") {
		t.Fatalf("revoked code plaintext: status %d body %s, want 403 invalid_join_code", closedStatus, closedBody)
	}

	// Nothing was created and nothing was audited: users and audit rows hold
	// only the governance setup (one admin + one issued login + code events).
	if got := h.countUsers(t); got != 1 {
		t.Fatalf("users after refused registrations = %d, want only the admin", got)
	}
	for _, action := range h.auditActions(t) {
		if action == "user_self_registered" {
			t.Fatal("a refused registration wrote a user_self_registered audit row")
		}
	}
}

func TestRegisterConflictsOnTakenEmailAndShortPassword(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	_, handler, adminToken := governanceReady(t, ctx)
	_, _, code := createJoinCode(t, handler, adminToken, "")

	// The admin's email is taken: the conflict is said plainly.
	status, raw := doRegister(t, handler, registerBody("admin@nevix.test", "some-self-pass-1", code.Code, ""))
	assertContractResponse(t, http.MethodPost, "/identity/register", status, raw)
	if status != http.StatusConflict || !contains(raw, "email_taken") {
		t.Fatalf("taken email: status %d body %s, want 409 email_taken", status, raw)
	}

	// A successful registration occupies its email; the same email answers
	// 409 even with a different password and display name.
	status, raw = doRegister(t, handler, registerBody("member2@nevix.test", "first-self-pass-1", code.Code, ""))
	assertContractResponse(t, http.MethodPost, "/identity/register", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("register setup: status %d body %s", status, raw)
	}
	status, raw = doRegister(t, handler, registerBody("MEMBER2@nevix.test", "second-self-pass-1", code.Code, ""))
	assertContractResponse(t, http.MethodPost, "/identity/register", status, raw)
	if status != http.StatusConflict || !contains(raw, "email_taken") {
		t.Fatalf("re-register normalized email: status %d body %s, want 409 email_taken", status, raw)
	}

	// Request-shape failures are 400s naming the violated field; the
	// over-length password proves the bcrypt-capacity bound answers with the
	// change-password surface's invalid_password shape, not a wrong verdict.
	for _, tc := range []struct {
		name string
		body []byte
		code string
	}{
		{"missing code", []byte(`{"email":"x@nevix.test","password":"long-enough-1"}`), "invalid_request"},
		{"missing password", []byte(`{"email":"x@nevix.test","join_code":"00000000"}`), "invalid_request"},
		{"missing email", []byte(`{"password":"long-enough-1","join_code":"00000000"}`), "invalid_request"},
		{"bad email", registerBody("not-an-email", "long-enough-1", code.Code, ""), "invalid_email"},
		{"short password", registerBody("x@nevix.test", "short", code.Code, ""), "password_too_short"},
		{"long password", registerBody("x@nevix.test", strings.Repeat("x", 73), code.Code, ""), "invalid_password"},
		{"long name", registerBody("x@nevix.test", "long-enough-1", code.Code, strings.Repeat("x", 129)), "invalid_display_name"},
	} {
		status, raw = doRegister(t, handler, tc.body)
		assertContractResponse(t, http.MethodPost, "/identity/register", status, raw)
		if status != http.StatusBadRequest || !contains(raw, `"`+tc.code+`"`) {
			t.Fatalf("%s: status %d body %s, want 400 %s", tc.name, status, raw, tc.code)
		}
	}
}

func TestRegisterIsRateLimitedPerEmail(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	_, handler, adminToken := governanceReady(t, ctx)
	_, _, code := createJoinCode(t, handler, adminToken, "")

	// Five failed registrations (wrong code) lock the email out; the sixth —
	// even with the correct code — answers 429 with a Retry-After header.
	for i := 0; i < 5; i++ {
		status, raw := doRegister(t, handler, registerBody("victim@nevix.test", "some-self-pass-1", "00000000", ""))
		assertContractResponse(t, http.MethodPost, "/identity/register", status, raw)
		if status != http.StatusForbidden {
			t.Fatalf("failure #%d: status %d body %s, want 403", i+1, status, raw)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/identity/register", bytes.NewReader(registerBody("victim@nevix.test", "some-self-pass-1", code.Code, "")))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assertContractResponse(t, http.MethodPost, "/identity/register", rec.Code, rec.Body.Bytes())
	if rec.Code != http.StatusTooManyRequests || !contains(rec.Body.Bytes(), "register_rate_limited") {
		t.Fatalf("locked-out register: status %d body %s, want 429 register_rate_limited", rec.Code, rec.Body.String())
	}
	retryAfter, err := strconv.Atoi(rec.Header().Get("Retry-After"))
	if err != nil || retryAfter <= 0 {
		t.Fatalf("Retry-After header %q, want a positive integer", rec.Header().Get("Retry-After"))
	}

	// The limiter counts per email: another email registers fine on the same
	// code while the first is locked out.
	status, raw := doRegister(t, handler, registerBody("bystander@nevix.test", "some-self-pass-1", code.Code, ""))
	assertContractResponse(t, http.MethodPost, "/identity/register", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("bystander register: status %d body %s, want 201", status, raw)
	}

	// The lockout is shared with login's per-email counter (one attack key
	// per email across both surfaces): the locked email cannot sidestep into
	// login failures either.
	if status, body, _ := doLogin(t, handler, "victim@nevix.test", "whatever-pass-1"); status != http.StatusTooManyRequests {
		t.Fatalf("login while register-locked: status %d body %s, want 429", status, body)
	}
}
