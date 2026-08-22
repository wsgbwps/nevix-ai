// Admin governance commands (issue #102): account creation with an initial
// password, disable with immediate session revocation, never-logged-in-only
// deletion, password reset, email change, role adjustment, and the
// last-active-admin protection — every governance write observed through the
// Module's HTTP surface against real PostgreSQL, with its audit row asserted
// in the same committed state.
package integrationtest

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// governanceAdmin creates the acting admin and returns a logged-in router
// plus the admin's token. The state is reset, so each test owns its world.
func governanceReady(t *testing.T, ctx context.Context) (*harness, http.Handler, string) {
	t.Helper()
	h := newHarness(t, ctx)
	h.resetUserState(t)
	h.insertUser(t, "admin@nevix.test", "admin-password-1", "admin", "active", false)
	cfg := h.cfg
	cfg.AdminEmail = ""
	cfg.AdminInitialPassword = ""
	_, handler := h.moduleWithConfig(t, cfg)
	status, _, login := doLogin(t, handler, "admin@nevix.test", "admin-password-1")
	if status != http.StatusOK {
		t.Fatalf("admin login: status %d", status)
	}
	return h, handler, login.Token
}

// managementUser is the decoded governance response body's user object.
type managementUser struct {
	ID                 string     `json:"id"`
	Email              string     `json:"email"`
	DisplayName        string     `json:"display_name"`
	Role               string     `json:"role"`
	Status             string     `json:"status"`
	MustChangePassword bool       `json:"must_change_password"`
	LastLoginAt        *time.Time `json:"last_login_at"`
	CreatedAt          time.Time  `json:"created_at"`
}

type userEnvelope struct {
	User managementUser `json:"user"`
}

// userIDByEmail resolves an account id through the owner credential.
func (h *harness) userIDByEmail(t *testing.T, email string) string {
	t.Helper()
	var id string
	if err := h.fixturePool.QueryRow(context.Background(),
		`SELECT id FROM public.users WHERE email = $1`, email,
	).Scan(&id); err != nil {
		t.Fatalf("resolve user id for %s: %v", email, err)
	}
	return id
}

// latestAuditEntry returns the newest audit row for one action, with its
// snapshots and metadata, through the owner credential.
func (h *harness) latestAuditEntry(t *testing.T, action string) (actorID, actorName string, targetID, targetName *string, metadata map[string]string) {
	t.Helper()
	var rawMetadata []byte
	err := h.fixturePool.QueryRow(context.Background(),
		`SELECT actor_user_id, actor_display_name, target_user_id, target_display_name, metadata
		 FROM public.audit_logs WHERE action = $1
		 ORDER BY created_at DESC, id DESC LIMIT 1`, action,
	).Scan(&actorID, &actorName, &targetID, &targetName, &rawMetadata)
	if err != nil {
		t.Fatalf("read latest %s audit row: %v", action, err)
	}
	if len(rawMetadata) > 0 {
		if err := json.Unmarshal(rawMetadata, &metadata); err != nil {
			t.Fatalf("decode %s audit metadata: %v", action, err)
		}
	}
	return actorID, actorName, targetID, targetName, metadata
}

// sessionsForUser counts live session rows for one account.
func (h *harness) sessionsForUser(t *testing.T, userID string) int {
	t.Helper()
	var count int
	if err := h.fixturePool.QueryRow(context.Background(),
		`SELECT count(*) FROM public.sessions WHERE user_id = $1`, userID,
	).Scan(&count); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	return count
}

func TestCreateUserIssuesAccountWithInitialPassword(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)

	body := []byte(`{"email":"New.Member@nevix.test","initial_password":"initial-pass-1","display_name":"New Member"}`)
	status, raw := doJSON(t, handler, http.MethodPost, "/identity/users", adminToken, body)
	assertContractResponse(t, http.MethodPost, "/identity/users", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("create user: status %d body %s", status, raw)
	}
	var created userEnvelope
	if err := json.Unmarshal(raw, &created); err != nil {
		t.Fatalf("decode created user: %v (%s)", err, raw)
	}
	if created.User.Role != "member" || created.User.Status != "active" {
		t.Fatalf("created account role/status = %s/%s, want member/active", created.User.Role, created.User.Status)
	}
	if !created.User.MustChangePassword {
		t.Fatal("created account lacks must_change_password; the initial password must force a change")
	}
	if created.User.LastLoginAt != nil {
		t.Fatal("created account has a last_login_at; it has never logged in")
	}
	if created.User.Email != "new.member@nevix.test" {
		t.Fatalf("created email %q, want the normalized form", created.User.Email)
	}

	// The audit row commits with the creation: actor snapshot is the admin,
	// target snapshot is the new account, metadata records the email.
	actorID, actorName, targetID, targetName, metadata := h.latestAuditEntry(t, "user_created")
	if actorID != h.userIDByEmail(t, "admin@nevix.test") || actorName != "admin@nevix.test" {
		t.Fatalf("user_created actor = %s/%s, want the acting admin", actorID, actorName)
	}
	if targetID == nil || *targetID != created.User.ID || targetName == nil || *targetName != "New Member" {
		t.Fatalf("user_created target = %v/%v, want the created account snapshot", targetID, targetName)
	}
	if metadata["email"] != "new.member@nevix.test" {
		t.Fatalf("user_created metadata = %v, want the email", metadata)
	}

	// The initial password logs in, flagged for the forced change flow.
	status, _, login := doLogin(t, handler, "new.member@nevix.test", "initial-pass-1")
	if status != http.StatusOK || !login.User.MustChangePassword {
		t.Fatalf("login with initial password: status %d must_change_password=%v, want 200/true", status, login.User.MustChangePassword)
	}

	// A duplicate email conflicts and commits nothing — not even an audit row.
	before := len(h.auditActions(t))
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users", adminToken,
		[]byte(`{"email":"new.member@nevix.test","initial_password":"another-pass-1"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users", status, raw)
	if status != http.StatusConflict || !contains(raw, `"email_taken"`) {
		t.Fatalf("duplicate email: status %d body %s, want 409 email_taken", status, raw)
	}
	if after := len(h.auditActions(t)); after != before {
		t.Fatalf("audit rows changed after a failed create (%d -> %d); the write and its audit row must commit together", before, after)
	}

	// Request-shape failures are 400s naming the violated field.
	for name, payload := range map[string][]byte{
		"missing password": []byte(`{"email":"x@nevix.test"}`),
		"missing email":    []byte(`{"initial_password":"long-enough-1"}`),
		"bad email":        []byte(`{"email":"not-an-email","initial_password":"long-enough-1"}`),
		"short password":   []byte(`{"email":"x@nevix.test","initial_password":"short"}`),
		"long name":        []byte(`{"email":"x@nevix.test","initial_password":"long-enough-1","display_name":"` + strings.Repeat("x", 129) + `"}`),
	} {
		status, raw = doJSON(t, handler, http.MethodPost, "/identity/users", adminToken, payload)
		assertContractResponse(t, http.MethodPost, "/identity/users", status, raw)
		if status != http.StatusBadRequest {
			t.Fatalf("%s: status %d body %s, want 400", name, status, raw)
		}
	}

	// Members never reach the command: the RequireAdmin guard answers 403.
	h.insertUser(t, "member@nevix.test", "member-password-1", "member", "active", false)
	_, _, memberLogin := doLogin(t, handler, "member@nevix.test", "member-password-1")
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users", memberLogin.Token,
		[]byte(`{"email":"another@nevix.test","initial_password":"initial-pass-1"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users", status, raw)
	if status != http.StatusForbidden || !contains(raw, `"forbidden"`) {
		t.Fatalf("member create: status %d body %s, want 403 forbidden", status, raw)
	}
}

func TestCreateUserDerivesDisplayNameFromEmailLocalPart(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	_, handler, adminToken := governanceReady(t, ctx)

	status, raw := doJSON(t, handler, http.MethodPost, "/identity/users", adminToken,
		[]byte(`{"email":"jane.doe@nevix.test","initial_password":"initial-pass-1"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users", status, raw)
	if status != http.StatusCreated {
		t.Fatalf("create user: status %d body %s", status, raw)
	}
	var created userEnvelope
	if err := json.Unmarshal(raw, &created); err != nil {
		t.Fatalf("decode created user: %v (%s)", err, raw)
	}
	if created.User.DisplayName != "jane.doe" {
		t.Fatalf("derived display name %q, want the email local part", created.User.DisplayName)
	}
}

func TestDisableUserRevokesAllSessionsImmediately(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)
	h.insertUser(t, "member@nevix.test", "member-password-1", "member", "active", false)

	// The member holds two live device sessions.
	_, _, first := doLogin(t, handler, "member@nevix.test", "member-password-1")
	_, _, second := doLogin(t, handler, "member@nevix.test", "member-password-1")
	memberID := h.userIDByEmail(t, "member@nevix.test")
	if got := h.sessionsForUser(t, memberID); got != 2 {
		t.Fatalf("member sessions before disable = %d, want 2", got)
	}

	status, raw := doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/disable", adminToken, []byte(`{}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/disable", status, raw)
	if status != http.StatusOK {
		t.Fatalf("disable: status %d body %s", status, raw)
	}
	var disabled userEnvelope
	if err := json.Unmarshal(raw, &disabled); err != nil {
		t.Fatalf("decode disabled user: %v (%s)", err, raw)
	}
	if disabled.User.Status != "disabled" {
		t.Fatalf("disabled user status = %s, want disabled", disabled.User.Status)
	}

	// Both existing sessions fail their very next request.
	for name, token := range map[string]string{"first device": first.Token, "second device": second.Token} {
		if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", token); status != http.StatusUnauthorized {
			t.Fatalf("%s after disable: status %d body %s, want 401", name, status, body)
		}
	}
	if got := h.sessionsForUser(t, memberID); got != 0 {
		t.Fatalf("member sessions after disable = %d, want 0", got)
	}

	// The audit row rode the same transaction, and a disabled login is dead.
	_, _, targetID, _, _ := h.latestAuditEntry(t, "user_disabled")
	if targetID == nil || *targetID != memberID {
		t.Fatalf("user_disabled target = %v, want the member", targetID)
	}
	if status, _, _ := doLogin(t, handler, "member@nevix.test", "member-password-1"); status != http.StatusForbidden {
		t.Fatalf("login after disable: status %d, want 403 account_disabled", status)
	}

	// Disabling an already-disabled account is an idempotent success that
	// writes no second audit row.
	before := len(h.auditActions(t))
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/disable", adminToken, []byte(`{}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/disable", status, raw)
	if status != http.StatusOK {
		t.Fatalf("repeat disable: status %d body %s, want 200", status, raw)
	}
	if after := len(h.auditActions(t)); after != before {
		t.Fatalf("repeat disable wrote audit rows (%d -> %d); a no-op is not an event", before, after)
	}
}

func TestLastActiveAdminCannotBeDisabledOrDemoted(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)
	adminID := h.userIDByEmail(t, "admin@nevix.test")

	// The only active admin cannot disable itself.
	status, raw := doJSON(t, handler, http.MethodPost, "/identity/users/"+adminID+"/disable", adminToken, []byte(`{}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/disable", status, raw)
	if status != http.StatusConflict || !contains(raw, `"last_admin_protected"`) {
		t.Fatalf("self disable as last admin: status %d body %s, want 409 last_admin_protected", status, raw)
	}

	// Nor demote itself.
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users/"+adminID+"/role", adminToken, []byte(`{"role":"member"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/role", status, raw)
	if status != http.StatusConflict || !contains(raw, `"last_admin_protected"`) {
		t.Fatalf("self demotion as last admin: status %d body %s, want 409 last_admin_protected", status, raw)
	}

	// A disabled admin does not count: with the only other admin disabled,
	// demotion of the last active one is still refused.
	h.insertUser(t, "admin2@nevix.test", "admin2-password-1", "admin", "disabled", false)
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users/"+adminID+"/role", adminToken, []byte(`{"role":"member"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/role", status, raw)
	if status != http.StatusConflict {
		t.Fatalf("demotion with only a disabled second admin: status %d, want 409", status)
	}

	// With a second active admin, the former may demote and disable itself.
	if _, err := h.fixturePool.Exec(ctx,
		`UPDATE public.users SET status = 'active' WHERE email = 'admin2@nevix.test'`); err != nil {
		t.Fatalf("activate second admin: %v", err)
	}
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users/"+adminID+"/role", adminToken, []byte(`{"role":"member"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/role", status, raw)
	if status != http.StatusOK {
		t.Fatalf("self demotion with another active admin: status %d body %s, want 200", status, raw)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/admin/users", adminToken); status != http.StatusForbidden {
		t.Fatalf("demoted admin: status %d body %s, want 403", status, body)
	}

	// And an active admin may disable another active admin when more remain.
	// The actor is admin2 now: the original admin demoted itself above.
	h.insertUser(t, "admin3@nevix.test", "admin3-password-1", "admin", "active", false)
	_, _, admin2Login := doLogin(t, handler, "admin2@nevix.test", "admin2-password-1")
	admin2ID := h.userIDByEmail(t, "admin2@nevix.test")
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users/"+admin2ID+"/disable", admin2Login.Token, []byte(`{}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/disable", status, raw)
	if status != http.StatusOK {
		t.Fatalf("disable of a non-last admin: status %d body %s, want 200", status, raw)
	}
}

func TestDeleteOnlyAllowsAccountsThatNeverLoggedIn(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)

	// A freshly created account (never logged in) is deletable.
	status, raw := doJSON(t, handler, http.MethodPost, "/identity/users", adminToken,
		[]byte(`{"email":"wrong-account@nevix.test","initial_password":"initial-pass-1"}`))
	if status != http.StatusCreated {
		t.Fatalf("create user: status %d body %s", status, raw)
	}
	var created userEnvelope
	json.Unmarshal(raw, &created)
	status, raw = doJSON(t, handler, http.MethodDelete, "/identity/users/"+created.User.ID, adminToken, nil)
	assertContractResponse(t, http.MethodDelete, "/identity/users/{userID}", status, raw)
	if status != http.StatusOK || !contains(raw, `"deleted"`) {
		t.Fatalf("delete never-logged-in account: status %d body %s, want 200 deleted", status, raw)
	}
	var gone int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM public.users WHERE id = $1`, created.User.ID,
	).Scan(&gone); err != nil || gone != 0 {
		t.Fatalf("deleted account still present: count=%d err=%v", gone, err)
	}
	// The audit row outlives the account it names (ADR-0009).
	_, _, targetID, _, metadata := h.latestAuditEntry(t, "user_deleted")
	if targetID == nil || *targetID != created.User.ID {
		t.Fatalf("user_deleted target = %v, want the deleted account's id", targetID)
	}
	if metadata["email"] != "wrong-account@nevix.test" {
		t.Fatalf("user_deleted metadata = %v, want the email snapshot", metadata)
	}

	// An account that has logged in is not deletable — history stays.
	h.insertUser(t, "member@nevix.test", "member-password-1", "member", "active", false)
	doLogin(t, handler, "member@nevix.test", "member-password-1")
	memberID := h.userIDByEmail(t, "member@nevix.test")
	status, raw = doJSON(t, handler, http.MethodDelete, "/identity/users/"+memberID, adminToken, nil)
	assertContractResponse(t, http.MethodDelete, "/identity/users/{userID}", status, raw)
	if status != http.StatusConflict || !contains(raw, `"user_has_logged_in"`) {
		t.Fatalf("delete logged-in account: status %d body %s, want 409 user_has_logged_in", status, raw)
	}

	// Unknown and malformed ids answer 404 alike.
	for name, id := range map[string]string{
		"unknown uuid":  "00000000-0000-0000-0000-000000000000",
		"malformed":     "not-a-uuid",
		"unknown admin": "01K1ABCDEF",
	} {
		status, raw = doJSON(t, handler, http.MethodDelete, "/identity/users/"+id, adminToken, nil)
		assertContractResponse(t, http.MethodDelete, "/identity/users/{userID}", status, raw)
		if status != http.StatusNotFound {
			t.Fatalf("delete %s: status %d body %s, want 404", name, status, raw)
		}
	}
}

func TestResetPasswordRevokesAllSessionsAndRearmsChange(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)
	h.insertUser(t, "member@nevix.test", "member-password-1", "member", "active", false)

	_, _, first := doLogin(t, handler, "member@nevix.test", "member-password-1")
	_, _, second := doLogin(t, handler, "member@nevix.test", "member-password-1")
	memberID := h.userIDByEmail(t, "member@nevix.test")

	status, raw := doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/reset-password", adminToken,
		[]byte(`{"initial_password":"replacement-pass-1"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/reset-password", status, raw)
	if status != http.StatusOK {
		t.Fatalf("reset password: status %d body %s", status, raw)
	}
	var reset userEnvelope
	if err := json.Unmarshal(raw, &reset); err != nil {
		t.Fatalf("decode reset user: %v (%s)", err, raw)
	}
	if !reset.User.MustChangePassword {
		t.Fatal("reset account lacks must_change_password; the new initial password must force a change")
	}

	// Every prior session is dead; the old password no longer works; the new
	// one logs in flagged for the forced change.
	for name, token := range map[string]string{"first device": first.Token, "second device": second.Token} {
		if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", token); status != http.StatusUnauthorized {
			t.Fatalf("%s after reset: status %d body %s, want 401", name, status, body)
		}
	}
	if got := h.sessionsForUser(t, memberID); got != 0 {
		t.Fatalf("member sessions after reset = %d, want 0", got)
	}
	if status, _, _ := doLogin(t, handler, "member@nevix.test", "member-password-1"); status != http.StatusUnauthorized {
		t.Fatalf("old password after reset: status %d, want 401", status)
	}
	status, _, login := doLogin(t, handler, "member@nevix.test", "replacement-pass-1")
	if status != http.StatusOK || !login.User.MustChangePassword {
		t.Fatalf("new password login: status %d must_change_password=%v, want 200/true", status, login.User.MustChangePassword)
	}

	_, _, targetID, _, _ := h.latestAuditEntry(t, "user_password_reset")
	if targetID == nil || *targetID != memberID {
		t.Fatalf("user_password_reset target = %v, want the member", targetID)
	}

	// A short replacement password is a request-shape failure.
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/reset-password", adminToken,
		[]byte(`{"initial_password":"short"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/reset-password", status, raw)
	if status != http.StatusBadRequest || !contains(raw, `"password_too_short"`) {
		t.Fatalf("short reset password: status %d body %s, want 400 password_too_short", status, raw)
	}
}

func TestChangeEmailMovesTheLoginIdentifier(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)
	h.insertUser(t, "member@nevix.test", "member-password-1", "member", "active", false)
	memberID := h.userIDByEmail(t, "member@nevix.test")

	status, raw := doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/email", adminToken,
		[]byte(`{"email":"renamed@nevix.test"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/email", status, raw)
	if status != http.StatusOK {
		t.Fatalf("change email: status %d body %s", status, raw)
	}
	var changed userEnvelope
	if err := json.Unmarshal(raw, &changed); err != nil {
		t.Fatalf("decode changed user: %v (%s)", err, raw)
	}
	if changed.User.Email != "renamed@nevix.test" {
		t.Fatalf("changed email = %s, want the new address", changed.User.Email)
	}

	// The old identifier stops working; the new one works with the same
	// password (the session survives: email is not a credential).
	if status, _, _ := doLogin(t, handler, "member@nevix.test", "member-password-1"); status != http.StatusUnauthorized {
		t.Fatalf("old email after change: status %d, want 401", status)
	}
	if status, _, _ := doLogin(t, handler, "renamed@nevix.test", "member-password-1"); status != http.StatusOK {
		t.Fatalf("new email after change: status %d, want 200", status)
	}

	// The audit row records the exact move.
	_, _, _, _, metadata := h.latestAuditEntry(t, "user_email_changed")
	if metadata["from"] != "member@nevix.test" || metadata["to"] != "renamed@nevix.test" {
		t.Fatalf("user_email_changed metadata = %v, want from/to", metadata)
	}

	// An email owned by another account conflicts; a member never reaches
	// the command.
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/email", adminToken,
		[]byte(`{"email":"admin@nevix.test"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/email", status, raw)
	if status != http.StatusConflict || !contains(raw, `"email_taken"`) {
		t.Fatalf("email taken: status %d body %s, want 409 email_taken", status, raw)
	}
	_, _, memberLogin := doLogin(t, handler, "renamed@nevix.test", "member-password-1")
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/email", memberLogin.Token,
		[]byte(`{"email":"selfserve@nevix.test"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/email", status, raw)
	if status != http.StatusForbidden {
		t.Fatalf("member email change: status %d body %s, want 403 (email is admin-only mutable)", status, raw)
	}
}

func TestChangeRoleAdjustsAdminAccessBothWays(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, adminToken := governanceReady(t, ctx)
	h.insertUser(t, "member@nevix.test", "member-password-1", "member", "active", false)
	memberID := h.userIDByEmail(t, "member@nevix.test")
	_, _, memberLogin := doLogin(t, handler, "member@nevix.test", "member-password-1")

	// Members start behind the admin guard.
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/admin/users", memberLogin.Token); status != http.StatusForbidden {
		t.Fatalf("member before promotion: status %d body %s, want 403", status, body)
	}

	// Promotion grants the admin surface on the very next request.
	status, raw := doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/role", adminToken,
		[]byte(`{"role":"admin"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/role", status, raw)
	if status != http.StatusOK {
		t.Fatalf("promote: status %d body %s", status, raw)
	}
	_, _, _, _, metadata := h.latestAuditEntry(t, "user_role_changed")
	if metadata["from"] != "member" || metadata["to"] != "admin" {
		t.Fatalf("user_role_changed metadata = %v, want from/to", metadata)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/admin/users", memberLogin.Token); status != http.StatusOK {
		t.Fatalf("promoted member: status %d body %s, want 200", status, body)
	}

	// Demotion takes it away again (the acting admin still has a peer).
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/role", adminToken,
		[]byte(`{"role":"member"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/role", status, raw)
	if status != http.StatusOK {
		t.Fatalf("demote: status %d body %s", status, raw)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/admin/users", memberLogin.Token); status != http.StatusForbidden {
		t.Fatalf("demoted member: status %d body %s, want 403", status, body)
	}

	// Unknown roles are request-shape failures.
	status, raw = doJSON(t, handler, http.MethodPost, "/identity/users/"+memberID+"/role", adminToken,
		[]byte(`{"role":"owner"}`))
	assertContractResponse(t, http.MethodPost, "/identity/users/{userID}/role", status, raw)
	if status != http.StatusBadRequest || !contains(raw, `"invalid_role"`) {
		t.Fatalf("unknown role: status %d body %s, want 400 invalid_role", status, raw)
	}
}

// Every governance route sits behind RequireAdmin: a member with a perfectly
// valid session is answered 403 forbidden before the command runs, and the
// target account is untouched. The table completes the gate coverage the
// individual command tests sample (issue #102 criterion: guards covered at
// Seam A).
func TestGovernanceRoutesRejectMembers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h, handler, _ := governanceReady(t, ctx)
	h.insertUser(t, "member@nevix.test", "member-password-1", "member", "active", false)
	adminID := h.userIDByEmail(t, "admin@nevix.test")
	_, _, memberLogin := doLogin(t, handler, "member@nevix.test", "member-password-1")

	for _, tc := range []struct {
		name   string
		method string
		path   string
		body   []byte
	}{
		{"create", http.MethodPost, "/identity/users", []byte(`{"email":"x@nevix.test","initial_password":"initial-pass-1"}`)},
		{"disable", http.MethodPost, "/identity/users/" + adminID + "/disable", []byte(`{}`)},
		{"reset-password", http.MethodPost, "/identity/users/" + adminID + "/reset-password", []byte(`{"initial_password":"whatever-pass-1"}`)},
		{"email", http.MethodPost, "/identity/users/" + adminID + "/email", []byte(`{"email":"x@nevix.test"}`)},
		{"role", http.MethodPost, "/identity/users/" + adminID + "/role", []byte(`{"role":"member"}`)},
		{"delete", http.MethodDelete, "/identity/users/" + adminID, nil},
	} {
		status, raw := doJSON(t, handler, tc.method, tc.path, memberLogin.Token, tc.body)
		assertContractResponse(t, tc.method, tc.path, status, raw)
		if status != http.StatusForbidden || !contains(raw, `"forbidden"`) {
			t.Fatalf("%s as member: status %d body %s, want 403 forbidden", tc.name, status, raw)
		}
	}

	// The guard answered before any command: the admin account is untouched.
	var status string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT status FROM public.users WHERE id = $1`, adminID,
	).Scan(&status); err != nil || status != "active" {
		t.Fatalf("admin account after member attempts = %q (err %v), want untouched active", status, err)
	}
	if got := len(h.auditActions(t)); got != 2 {
		t.Fatalf("audit rows after member attempts = %d, want the 2 setup logins only (no governance row)", got)
	}
}
