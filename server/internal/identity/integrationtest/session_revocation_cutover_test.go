// Session revocation cutover contract tests (issue #143): the self-service
// password change, the admin password reset, and the user disable switch
// their session hygiene to the Session module's unified revocation —
// others for the change, all for reset and disable — with the command audit
// staying minimal (one business action, no session revocation rows), every
// mutation and its revocation committing or rolling back in one Write
// Transaction, and the disable/change-password commit order deciding the
// outcome deterministically. Observed through the Module's HTTP surface
// against real PostgreSQL.
package integrationtest

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// auditDelta returns the actions appended to the audit log since the given
// snapshot length, in insert order.
func (h *harness) auditDelta(t *testing.T, since int) []string {
	t.Helper()
	actions := h.auditActions(t)
	if len(actions) < since {
		t.Fatalf("audit log shrank: %d actions after snapshot of %d", len(actions), since)
	}
	return actions[since:]
}

// memberWithTwoDevices resets state, creates an active member with two live
// device sessions, and returns the harness, handler, admin token, member
// id, and both device tokens.
func memberWithTwoDevices(t *testing.T, ctx context.Context) (h *harness, handler http.Handler, adminToken, memberID, first, second string) {
	t.Helper()
	h, handler, adminToken = governanceReady(t, ctx)
	h.insertUser(t, "member@nevix.test", "member-password-1", "member", "active", false)
	status, _, loginA := doLogin(t, handler, "member@nevix.test", "member-password-1")
	if status != http.StatusOK {
		t.Fatalf("first member login: status %d", status)
	}
	status, _, loginB := doLogin(t, handler, "member@nevix.test", "member-password-1")
	if status != http.StatusOK {
		t.Fatalf("second member login: status %d", status)
	}
	return h, handler, adminToken, h.userIDByEmail(t, "member@nevix.test"), loginA.Token, loginB.Token
}

func TestChangePasswordWritesOnlyPasswordChangedAudit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, _, memberID, first, second := memberWithTwoDevices(t, ctx)
	if got := h.sessionsForUser(t, memberID); got != 2 {
		t.Fatalf("member sessions before change = %d, want 2", got)
	}

	auditBefore := len(h.auditActions(t))
	status, body := doChangePassword(t, handler, first, "member-password-1", rotatedPassword)
	assertContractResponse(t, http.MethodPost, "/identity/auth/change-password", status, body)
	if status != http.StatusOK {
		t.Fatalf("change-password: status %d body %s", status, body)
	}

	// The audit fact is exactly one password_changed row: the others
	// disposition adds no session_revoked entry of its own.
	if delta := h.auditDelta(t, auditBefore); len(delta) != 1 || delta[0] != "password_changed" {
		t.Fatalf("audit delta after change = %v, want exactly one password_changed", delta)
	}

	// The other device lost authentication at the commit; the caller kept it.
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", second); status != http.StatusUnauthorized {
		t.Fatalf("other session after change: status %d body %s, want 401", status, body)
	}
	status, body = doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", first)
	assertContractResponse(t, http.MethodGet, "/identity/users/me", status, body)
	if status != http.StatusOK {
		t.Fatalf("calling session after change: status %d body %s, want 200", status, body)
	}
	if got := h.sessionsForUser(t, memberID); got != 1 {
		t.Fatalf("member sessions after change = %d, want only the caller's", got)
	}
}

func TestDisableWritesOnlyUserDisabledAudit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken, memberID, first, second := memberWithTwoDevices(t, ctx)

	auditBefore := len(h.auditActions(t))
	status, raw := doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/disable", adminToken, []byte(`{}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/disable", status, raw)
	if status != http.StatusOK {
		t.Fatalf("disable: status %d body %s", status, raw)
	}

	// The audit fact is exactly one user_disabled row: the all disposition
	// adds no session_revoked entry of its own.
	if delta := h.auditDelta(t, auditBefore); len(delta) != 1 || delta[0] != "user_disabled" {
		t.Fatalf("audit delta after disable = %v, want exactly one user_disabled", delta)
	}

	// Every existing session fails authentication after the commit.
	for name, token := range map[string]string{"first device": first, "second device": second} {
		if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", token); status != http.StatusUnauthorized {
			t.Fatalf("%s after disable: status %d body %s, want 401", name, status, body)
		}
	}
	if got := h.sessionsForUser(t, memberID); got != 0 {
		t.Fatalf("member sessions after disable = %d, want 0", got)
	}
}

func TestResetPasswordWritesOnlyUserPasswordResetAudit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken, memberID, first, second := memberWithTwoDevices(t, ctx)

	auditBefore := len(h.auditActions(t))
	status, raw := doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/reset-password", adminToken,
		[]byte(`{"initial_password":"replacement-pass-1"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/reset-password", status, raw)
	if status != http.StatusOK {
		t.Fatalf("reset password: status %d body %s", status, raw)
	}

	// The audit fact is exactly one user_password_reset row: the all
	// disposition adds no session_revoked entry of its own.
	if delta := h.auditDelta(t, auditBefore); len(delta) != 1 || delta[0] != "user_password_reset" {
		t.Fatalf("audit delta after reset = %v, want exactly one user_password_reset", delta)
	}

	for name, token := range map[string]string{"first device": first, "second device": second} {
		if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", token); status != http.StatusUnauthorized {
			t.Fatalf("%s after reset: status %d body %s, want 401", name, status, body)
		}
	}
	if got := h.sessionsForUser(t, memberID); got != 0 {
		t.Fatalf("member sessions after reset = %d, want 0", got)
	}
}

// TestDisableCommittedBeforeWaitingPasswordChangeFailsIt: the change's
// credential verification runs under the caller-owned FOR UPDATE row lock,
// where the active status is re-read. A blocker committing a disable while
// the change waits on that lock makes the change fail with the endpoint's
// uniform credential answer — no hash rotation, no revocation, no audit.
func TestDisableCommittedBeforeWaitingPasswordChangeFailsIt(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, _, memberID, first, _ := memberWithTwoDevices(t, ctx)

	var hashBefore string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT password_hash FROM public.users WHERE id = $1`, memberID,
	).Scan(&hashBefore); err != nil {
		t.Fatalf("read committed hash before the race: %v", err)
	}

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
		`SELECT id FROM public.users WHERE email = $1 FOR UPDATE`, "member@nevix.test",
	); err != nil {
		t.Fatalf("hold the member row lock: %v", err)
	}

	type outcome struct {
		status int
		body   []byte
	}
	done := make(chan outcome, 1)
	go func() {
		status, body := doChangePassword(t, handler, first, "member-password-1", rotatedPassword)
		done <- outcome{status: status, body: body}
	}()

	// The change must wait behind the blocker's row lock, not verify
	// against pre-lock state.
	select {
	case <-done:
		t.Fatal("change-password completed while another transaction held the member row lock")
	case <-time.After(1500 * time.Millisecond):
	}

	// The blocker is the disable that commits first.
	if _, err := blocker.Exec(ctx,
		`UPDATE public.users SET status = 'disabled', updated_at = now() WHERE email = $1`, "member@nevix.test",
	); err != nil {
		t.Fatalf("disable inside the blocker: %v", err)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatalf("commit the blocker: %v", err)
	}

	select {
	case out := <-done:
		if out.status != http.StatusUnauthorized || !contains(out.body, `"invalid_credentials"`) {
			t.Fatalf("change-password after the racing disable committed: status %d body %s, want 401 invalid_credentials", out.status, out.body)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("change-password did not finish after the lock holder committed")
	}

	// No partial write survived the failed change.
	var hashAfter string
	var status string
	var mustChange bool
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT password_hash, status, must_change_password FROM public.users WHERE id = $1`, memberID,
	).Scan(&hashAfter, &status, &mustChange); err != nil {
		t.Fatalf("read user after the race: %v", err)
	}
	if hashAfter != hashBefore {
		t.Fatal("password hash rotated by a change that lost the race")
	}
	if status != "disabled" || mustChange {
		t.Fatalf("user after the race = %s/must_change=%v, want disabled/false", status, mustChange)
	}
	if got := h.sessionsForUser(t, memberID); got != 2 {
		t.Fatalf("member sessions after the lost race = %d, want 2 (no partial revocation)", got)
	}
	for _, action := range h.auditActions(t) {
		if action == "password_changed" {
			t.Fatal("the lost race wrote a password_changed audit row")
		}
	}
}

// TestDisableAfterCommittedPasswordChangeRevokesEverySession: a change that
// commits first keeps its calling session, and a later disable still covers
// it — the all disposition includes the change's surviving current session.
func TestDisableAfterCommittedPasswordChangeRevokesEverySession(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken, memberID, first, second := memberWithTwoDevices(t, ctx)

	status, body := doChangePassword(t, handler, first, "member-password-1", rotatedPassword)
	assertContractResponse(t, http.MethodPost, "/identity/auth/change-password", status, body)
	if status != http.StatusOK {
		t.Fatalf("change-password: status %d body %s", status, body)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", second); status != http.StatusUnauthorized {
		t.Fatalf("other session after change: status %d body %s, want 401", status, body)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", first); status != http.StatusOK {
		t.Fatalf("calling session after change: status %d body %s, want 200", status, body)
	}

	// The later disable revokes everything, the survivor included.
	status, raw := doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/disable", adminToken, []byte(`{}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/disable", status, raw)
	if status != http.StatusOK {
		t.Fatalf("disable after a committed change: status %d body %s", status, raw)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", first); status != http.StatusUnauthorized {
		t.Fatalf("surviving session after disable: status %d body %s, want 401", status, body)
	}
	if got := h.sessionsForUser(t, memberID); got != 0 {
		t.Fatalf("member sessions after disable = %d, want 0", got)
	}
}

// TestChangePasswordRollsBackRevocationWithItsAuditRow: a failure at the
// command's last participant — the audit write, broken by a fixture trigger
// — rolls back the rotation, the others revocation, and the flag clear
// together; the same change succeeds once the sink is repaired.
func TestChangePasswordRollsBackRevocationWithItsAuditRow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, _, memberID, first, second := memberWithTwoDevices(t, ctx)

	restore := h.failAuditWritesFor(t, "password_changed")
	status, body := doChangePassword(t, handler, first, "member-password-1", rotatedPassword)
	assertContractResponse(t, http.MethodPost, "/identity/auth/change-password", status, body)
	if status != http.StatusInternalServerError || !contains(body, `"internal_error"`) {
		t.Fatalf("change with a broken audit sink: status %d body %s, want 500 internal_error", status, body)
	}
	if got := h.sessionsForUser(t, memberID); got != 2 {
		t.Fatalf("sessions after rolled-back change = %d, want 2 (revocation rolled back too)", got)
	}
	if status, _, _ := doLogin(t, handler, "member@nevix.test", "member-password-1"); status != http.StatusOK {
		t.Fatal("old password stopped working after a rolled-back change")
	}
	if status, _, _ := doLogin(t, handler, "member@nevix.test", rotatedPassword); status != http.StatusUnauthorized {
		t.Fatal("new password worked after a rolled-back change")
	}
	for _, action := range h.auditActions(t) {
		if action == "password_changed" {
			t.Fatal("rolled-back change left a password_changed audit row")
		}
	}

	restore()
	status, body = doChangePassword(t, handler, first, "member-password-1", rotatedPassword)
	assertContractResponse(t, http.MethodPost, "/identity/auth/change-password", status, body)
	if status != http.StatusOK {
		t.Fatalf("change after audit repair: status %d body %s, want 200", status, body)
	}
	if got := h.sessionsForUser(t, memberID); got != 1 {
		t.Fatalf("sessions after repaired change = %d, want only the caller's", got)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", second); status != http.StatusUnauthorized {
		t.Fatalf("other session after repaired change: status %d body %s, want 401", status, body)
	}
}

// TestDisableRollsBackRevocationWithItsAuditRow: a broken audit sink rolls
// the status mutation and the all revocation back together — the account
// stays active with its sessions — and the disable succeeds after repair.
func TestDisableRollsBackRevocationWithItsAuditRow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken, memberID, first, _ := memberWithTwoDevices(t, ctx)

	restore := h.failAuditWritesFor(t, "user_disabled")
	status, raw := doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/disable", adminToken, []byte(`{}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/disable", status, raw)
	if status != http.StatusInternalServerError || !contains(raw, `"internal_error"`) {
		t.Fatalf("disable with a broken audit sink: status %d body %s, want 500 internal_error", status, raw)
	}
	var userStatus string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT status FROM public.users WHERE id = $1`, memberID,
	).Scan(&userStatus); err != nil || userStatus != "active" {
		t.Fatalf("user status after rolled-back disable = %q (err %v), want active", userStatus, err)
	}
	if got := h.sessionsForUser(t, memberID); got != 2 {
		t.Fatalf("sessions after rolled-back disable = %d, want 2", got)
	}
	status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", first)
	assertContractResponse(t, http.MethodGet, "/identity/users/me", status, body)
	if status != http.StatusOK {
		t.Fatalf("session after rolled-back disable: status %d body %s, want 200", status, body)
	}

	restore()
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/disable", adminToken, []byte(`{}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/disable", status, raw)
	if status != http.StatusOK {
		t.Fatalf("disable after audit repair: status %d body %s, want 200", status, raw)
	}
	if got := h.sessionsForUser(t, memberID); got != 0 {
		t.Fatalf("sessions after repaired disable = %d, want 0", got)
	}
}

// TestResetPasswordRollsBackRevocationWithItsAuditRow: a broken audit sink
// rolls the credential rotation and the all revocation back together; the
// reset succeeds after repair.
func TestResetPasswordRollsBackRevocationWithItsAuditRow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken, memberID, first, _ := memberWithTwoDevices(t, ctx)

	restore := h.failAuditWritesFor(t, "user_password_reset")
	status, raw := doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/reset-password", adminToken,
		[]byte(`{"initial_password":"replacement-pass-1"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/reset-password", status, raw)
	if status != http.StatusInternalServerError || !contains(raw, `"internal_error"`) {
		t.Fatalf("reset with a broken audit sink: status %d body %s, want 500 internal_error", status, raw)
	}
	if got := h.sessionsForUser(t, memberID); got != 2 {
		t.Fatalf("sessions after rolled-back reset = %d, want 2", got)
	}
	if status, _, _ := doLogin(t, handler, "member@nevix.test", "member-password-1"); status != http.StatusOK {
		t.Fatal("old password stopped working after a rolled-back reset")
	}

	restore()
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/reset-password", adminToken,
		[]byte(`{"initial_password":"replacement-pass-1"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/reset-password", status, raw)
	if status != http.StatusOK {
		t.Fatalf("reset after audit repair: status %d body %s, want 200", status, raw)
	}
	if got := h.sessionsForUser(t, memberID); got != 0 {
		t.Fatalf("sessions after repaired reset = %d, want 0", got)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", first); status != http.StatusUnauthorized {
		t.Fatalf("session after repaired reset: status %d body %s, want 401", status, body)
	}
}
