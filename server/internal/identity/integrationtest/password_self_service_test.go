// Self-service and first-login password change hygiene (issue #101): a
// session whose account still owes the forced initial-password change can
// only complete the change (other business endpoints answer 403
// password_change_required); the first-login change clears the flag and
// activates the account; a self-service change revokes every OTHER session
// while the calling session survives; the display name is self-service and
// lands in the users table the directory reads. Every observed response is
// asserted against the OpenAPI contract.
package integrationtest

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/identity"
)

const (
	initialPassword = "admin-set-initial-1"
	rotatedPassword = "rotated-password-1"
)

// forcedChangeModule resets state and creates an active member whose
// must_change_password flag is set — the first-login shape an admin-created
// account (or the bootstrap admin) has.
func (h *harness) forcedChangeModule(t *testing.T) (*identity.Module, http.Handler) {
	t.Helper()
	h.resetUserState(t)
	h.insertUser(t, loginEmail, initialPassword, "member", "active", true)
	cfg := h.cfg
	cfg.AdminEmail = ""
	cfg.AdminInitialPassword = ""
	return h.moduleWithConfig(t, cfg)
}

// rotationModule resets state and creates an active user with no pending
// change — the everyday self-service rotation shape.
func (h *harness) rotationModule(t *testing.T) (*identity.Module, http.Handler) {
	t.Helper()
	module, handler := h.loginReadyModule(t)
	return module, handler
}

// mustChangeFlag reads the users-table flag for one email.
func (h *harness) mustChangeFlag(t *testing.T, email string) bool {
	t.Helper()
	var flag bool
	if err := h.fixturePool.QueryRow(context.Background(),
		`SELECT must_change_password FROM public.users WHERE email = $1`, email,
	).Scan(&flag); err != nil {
		t.Fatalf("read must_change_password: %v", err)
	}
	return flag
}

// storedDisplayName reads the users-table display name for one email — the
// row the (issue #102) user-directory endpoint will list.
func (h *harness) storedDisplayName(t *testing.T, email string) string {
	t.Helper()
	var name string
	if err := h.fixturePool.QueryRow(context.Background(),
		`SELECT display_name FROM public.users WHERE email = $1`, email,
	).Scan(&name); err != nil {
		t.Fatalf("read display_name: %v", err)
	}
	return name
}

// lastAuditAction returns the newest audit action.
func (h *harness) lastAuditAction(t *testing.T) string {
	t.Helper()
	actions := h.auditActions(t)
	if len(actions) == 0 {
		t.Fatal("no audit rows to read")
	}
	return actions[len(actions)-1]
}

func TestPendingPasswordChangeBlocksBusinessEndpoints(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.forcedChangeModule(t)

	// Login still succeeds and flags the pending change in the response.
	status, body, login := doLogin(t, handler, loginEmail, initialPassword)
	assertContractResponse(t, http.MethodPost, "/identity/auth/login", status, body)
	if status != http.StatusOK || !login.User.MustChangePassword {
		t.Fatalf("forced-change login: status %d flag %v, want 200 with must_change_password=true", status, login.User.MustChangePassword)
	}

	// A business endpoint is gated: the display-name update answers 403
	// password_change_required, never reaching the command.
	status, body = doUpdateMe(t, handler, login.Token, "Renamed Too Early")
	assertContractResponse(t, http.MethodPatch, "/identity/users/me", status, body)
	if status != http.StatusForbidden || !contains(body, `"password_change_required"`) {
		t.Fatalf("display-name update during forced change: status %d body %s, want 403 password_change_required", status, body)
	}
	if got := h.storedDisplayName(t, loginEmail); got != loginEmail {
		t.Fatalf("display name changed during forced change: %q", got)
	}

	// The auth-scoped routes stay usable: me reads the flagged account…
	status, body = doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", login.Token)
	assertContractResponse(t, http.MethodGet, "/identity/users/me", status, body)
	if status != http.StatusOK || !contains(body, `"must_change_password":true`) {
		t.Fatalf("me during forced change: status %d body %s, want the flagged account", status, body)
	}

	// …the change command itself runs (a wrong current password reaches the
	// command and answers invalid_credentials, not the gate)…
	status, body = doChangePassword(t, handler, login.Token, "wrong-current", rotatedPassword)
	assertContractResponse(t, http.MethodPost, "/identity/auth/change-password", status, body)
	if status != http.StatusUnauthorized || !contains(body, `"invalid_credentials"`) {
		t.Fatalf("change-password with wrong current during forced change: status %d body %s, want 401 invalid_credentials", status, body)
	}

	// …and logout still ends the session.
	status, body = doLogout(t, handler, login.Token)
	assertContractResponse(t, http.MethodPost, "/identity/auth/logout", status, body)
	if status != http.StatusOK {
		t.Fatalf("logout during forced change: status %d body %s, want 200", status, body)
	}
}

func TestFirstLoginChangePasswordClearsFlagAndActivatesAccount(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.forcedChangeModule(t)

	status, body, login := doLogin(t, handler, loginEmail, initialPassword)
	assertContractResponse(t, http.MethodPost, "/identity/auth/login", status, body)
	if status != http.StatusOK {
		t.Fatalf("forced-change login: status %d body %s", status, body)
	}

	status, body = doChangePassword(t, handler, login.Token, initialPassword, rotatedPassword)
	assertContractResponse(t, http.MethodPost, "/identity/auth/change-password", status, body)
	if status != http.StatusOK || !contains(body, `"password_changed"`) {
		t.Fatalf("first-login change: status %d body %s, want 200 password_changed", status, body)
	}
	if h.mustChangeFlag(t, loginEmail) {
		t.Fatal("must_change_password still set after the first-login change")
	}
	if last := h.lastAuditAction(t); last != "password_changed" {
		t.Fatalf("audit after first-login change = %q, want password_changed", last)
	}

	// The calling session survives and reads the cleared flag.
	status, body = doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", login.Token)
	assertContractResponse(t, http.MethodGet, "/identity/users/me", status, body)
	if status != http.StatusOK || !contains(body, `"must_change_password":false`) {
		t.Fatalf("me after first-login change: status %d body %s, want the cleared flag", status, body)
	}

	// The gated business endpoint is usable again.
	status, body = doUpdateMe(t, handler, login.Token, "Activated Member")
	assertContractResponse(t, http.MethodPatch, "/identity/users/me", status, body)
	if status != http.StatusOK {
		t.Fatalf("display-name update after first-login change: status %d body %s, want 200", status, body)
	}

	// The old password no longer works; the new one does, unflagged.
	if status, body, _ := doLogin(t, handler, loginEmail, initialPassword); status != http.StatusUnauthorized {
		t.Fatalf("old password after change: status %d body %s, want 401", status, body)
	}
	status, body, relogin := doLogin(t, handler, loginEmail, rotatedPassword)
	assertContractResponse(t, http.MethodPost, "/identity/auth/login", status, body)
	if status != http.StatusOK || relogin.User.MustChangePassword {
		t.Fatalf("new password login: status %d flag %v, want 200 without a pending change", status, relogin.User.MustChangePassword)
	}
}

func TestChangePasswordRevokesAllOtherSessions(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.rotationModule(t)

	status, _, first := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("first login: status %d", status)
	}
	status, _, second := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("second login: status %d", status)
	}
	if got := sessionCount(t, h); got != 2 {
		t.Fatalf("sessions before change = %d, want 2", got)
	}

	status, body := doChangePassword(t, handler, first.Token, loginPassword, rotatedPassword)
	assertContractResponse(t, http.MethodPost, "/identity/auth/change-password", status, body)
	if status != http.StatusOK {
		t.Fatalf("change-password: status %d body %s", status, body)
	}

	// The other device's session is gone; the calling session survives —
	// the current-session disposition the contract defines.
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", second.Token); status != http.StatusUnauthorized {
		t.Fatalf("other session after change: status %d body %s, want 401", status, body)
	}
	status, body = doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", first.Token)
	assertContractResponse(t, http.MethodGet, "/identity/users/me", status, body)
	if status != http.StatusOK {
		t.Fatalf("calling session after change: status %d body %s, want 200", status, body)
	}
	if got := sessionCount(t, h); got != 1 {
		t.Fatalf("sessions after change = %d, want only the caller's", got)
	}
	if last := h.lastAuditAction(t); last != "password_changed" {
		t.Fatalf("audit after change = %q, want password_changed", last)
	}
}

func TestChangePasswordRejectsWrongCurrentPassword(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.rotationModule(t)
	status, _, login := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("login: status %d", status)
	}

	status, body := doChangePassword(t, handler, login.Token, "wrong-current", rotatedPassword)
	assertContractResponse(t, http.MethodPost, "/identity/auth/change-password", status, body)
	if status != http.StatusUnauthorized || !contains(body, `"invalid_credentials"`) {
		t.Fatalf("wrong current password: status %d body %s, want 401 invalid_credentials", status, body)
	}

	// Nothing changed: the old password still verifies, sessions survive,
	// and no password_changed audit row appears.
	if status, _, _ := doLogin(t, handler, loginEmail, loginPassword); status != http.StatusOK {
		t.Fatalf("old password after failed change: status %d, want 200", status)
	}
	if got := sessionCount(t, h); got != 2 {
		t.Fatalf("sessions after failed change = %d, want 2", got)
	}
	for _, action := range h.auditActions(t) {
		if action == "password_changed" {
			t.Fatal("failed change wrote a password_changed audit row")
		}
	}
}

func TestChangePasswordRejectsPolicyViolatingNewPassword(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.rotationModule(t)
	status, _, login := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("login: status %d", status)
	}

	status, body := doChangePassword(t, handler, login.Token, loginPassword, "short")
	assertContractResponse(t, http.MethodPost, "/identity/auth/change-password", status, body)
	if status != http.StatusBadRequest || !contains(body, `"invalid_password"`) {
		t.Fatalf("short new password: status %d body %s, want 400 invalid_password", status, body)
	}

	// A body missing a required field is invalid_request.
	status, body = doAuthenticatedJSON(t, handler, http.MethodPost, "/identity/auth/change-password", login.Token, []byte(`{"current_password":"x"}`))
	assertContractResponse(t, http.MethodPost, "/identity/auth/change-password", status, body)
	if status != http.StatusBadRequest || !contains(body, `"invalid_request"`) {
		t.Fatalf("missing new_password: status %d body %s, want 400 invalid_request", status, body)
	}
}

func TestChangePasswordEnforcesPasswordByteBoundaries(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.rotationModule(t)
	status, _, login := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("login: status %d", status)
	}

	// Exactly at the bcrypt capacity the change succeeds…
	boundary := strings.Repeat("a", 72)
	status, body := doChangePassword(t, handler, login.Token, loginPassword, boundary)
	assertContractResponse(t, http.MethodPost, "/identity/auth/change-password", status, body)
	if status != http.StatusOK {
		t.Fatalf("72-byte new password: status %d body %s, want 200", status, body)
	}
	// …and one byte past it is a documented client error, never a 500.
	status, body = doChangePassword(t, handler, login.Token, boundary, boundary+"a")
	assertContractResponse(t, http.MethodPost, "/identity/auth/change-password", status, body)
	if status != http.StatusBadRequest || !contains(body, `"invalid_password"`) {
		t.Fatalf("73-byte new password: status %d body %s, want 400 invalid_password", status, body)
	}
}

func TestChangePasswordSerializesConcurrentChanges(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.rotationModule(t)
	status, _, first := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("first login: status %d", status)
	}
	status, _, second := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("second login: status %d", status)
	}

	// Two devices rotate concurrently: verification runs inside the write
	// transaction against the committed hash, so exactly one succeeds and
	// the loser answers 401 — never two 200s with an order-dependent result.
	const newA = "winner-password-1"
	const newB = "loser-password-1"
	results := make(chan int, 2)
	go func() {
		status, _ := doChangePassword(t, handler, first.Token, loginPassword, newA)
		results <- status
	}()
	go func() {
		status, _ := doChangePassword(t, handler, second.Token, loginPassword, newB)
		results <- status
	}()
	statuses := []int{<-results, <-results}
	slices.Sort(statuses)
	if !slices.Equal(statuses, []int{http.StatusOK, http.StatusUnauthorized}) {
		t.Fatalf("concurrent change statuses = %v, want exactly one 200 and one 401", statuses)
	}

	// The winner is whichever device got the 200: its session survives, the
	// loser's is revoked, and only the winner's new password verifies.
	loser, loserPassword := second, newB
	winnerPassword := newA
	if status, _ := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", first.Token); status != http.StatusOK {
		loser, winnerPassword, loserPassword = first, newB, newA
	}
	if status, _ := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", loser.Token); status != http.StatusUnauthorized {
		t.Fatalf("loser session: status %d, want 401", status)
	}
	if got := sessionCount(t, h); got != 1 {
		t.Fatalf("sessions after concurrent change = %d, want only the winner's", got)
	}
	if status, _, _ := doLogin(t, handler, loginEmail, winnerPassword); status != http.StatusOK {
		t.Fatalf("winner password after concurrent change: status %d, want 200", status)
	}
	if status, _, _ := doLogin(t, handler, loginEmail, loserPassword); status != http.StatusUnauthorized {
		t.Fatalf("loser password after concurrent change: status %d, want 401", status)
	}
}

func TestChangePasswordRequiresASession(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.rotationModule(t)

	status, body := doChangePassword(t, handler, "", loginPassword, rotatedPassword)
	assertContractResponse(t, http.MethodPost, "/identity/auth/change-password", status, body)
	if status != http.StatusUnauthorized || !contains(body, `"unauthorized"`) {
		t.Fatalf("change-password without token: status %d body %s, want 401 unauthorized", status, body)
	}
}

func TestUpdateMeChangesDisplayNameVisibleInDirectory(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.rotationModule(t)
	status, _, login := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("login: status %d", status)
	}

	status, body := doUpdateMe(t, handler, login.Token, "  Elio Renamed  ")
	assertContractResponse(t, http.MethodPatch, "/identity/users/me", status, body)
	if status != http.StatusOK || !contains(body, `"display_name":"Elio Renamed"`) {
		t.Fatalf("display-name update: status %d body %s, want the trimmed new name", status, body)
	}

	// The read reflects it…
	status, body = doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", login.Token)
	assertContractResponse(t, http.MethodGet, "/identity/users/me", status, body)
	if status != http.StatusOK || !contains(body, `"display_name":"Elio Renamed"`) {
		t.Fatalf("me after rename: status %d body %s, want the new name", status, body)
	}

	// …the rename rides the same write transaction as its audit row…
	if last := h.lastAuditAction(t); last != "display_name_changed" {
		t.Fatalf("audit after rename = %q, want display_name_changed", last)
	}

	// …and the users table — the directory's source of truth (the directory
	// endpoint itself lands with #102 and its own visibility tests) — carries it.
	if got := h.storedDisplayName(t, loginEmail); got != "Elio Renamed" {
		t.Fatalf("stored display name = %q, want %q", got, "Elio Renamed")
	}
}

func TestUpdateMeCountsDisplayNameInCharactersNotBytes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.rotationModule(t)
	status, _, login := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("login: status %d", status)
	}

	// Length follows the contract's maxLength semantics — Unicode
	// characters, not bytes: 128 CJK characters are 384 UTF-8 bytes yet
	// within the documented bound…
	cjkName := strings.Repeat("深", 128)
	status, body := doUpdateMe(t, handler, login.Token, cjkName)
	assertContractResponse(t, http.MethodPatch, "/identity/users/me", status, body)
	if status != http.StatusOK {
		t.Fatalf("128-character CJK name: status %d body %s, want 200 (length counts characters)", status, body)
	}
	if got := h.storedDisplayName(t, loginEmail); got != cjkName {
		t.Fatalf("stored CJK name mismatch: %d runes", len([]rune(got)))
	}

	// …while one character past the bound is rejected — ASCII, so the byte
	// and character counts agree on the rejection boundary.
	status, body = doUpdateMe(t, handler, login.Token, strings.Repeat("x", 129))
	assertContractResponse(t, http.MethodPatch, "/identity/users/me", status, body)
	if status != http.StatusBadRequest || !contains(body, `"invalid_display_name"`) {
		t.Fatalf("129-character name: status %d body %s, want 400 invalid_display_name", status, body)
	}

	// Trimming normalizes storage but never rescues an over-length value:
	// 128 characters plus padding exceeds the contract's raw maxLength and
	// is rejected even though the trimmed value would fit.
	padded := "  " + strings.Repeat("y", 128) + "  "
	status, body = doUpdateMe(t, handler, login.Token, padded)
	assertContractResponse(t, http.MethodPatch, "/identity/users/me", status, body)
	if status != http.StatusBadRequest || !contains(body, `"invalid_display_name"`) {
		t.Fatalf("padded 130-character name: status %d body %s, want 400 invalid_display_name (length counts the raw value)", status, body)
	}
	if got := h.storedDisplayName(t, loginEmail); got != cjkName {
		t.Fatalf("display name changed by a rejected update: %q", got)
	}
}

func TestUpdateMeValidatesDisplayName(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.rotationModule(t)
	status, _, login := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("login: status %d", status)
	}

	for name, payload := range map[string][]byte{
		"missing field":   []byte(`{}`),
		"whitespace only": []byte(`{"display_name":"   "}`),
		"too long":        []byte(`{"display_name":"` + strings.Repeat("x", 129) + `"}`),
	} {
		status, body := doAuthenticatedJSON(t, handler, http.MethodPatch, "/identity/users/me", login.Token, payload)
		assertContractResponse(t, http.MethodPatch, "/identity/users/me", status, body)
		switch name {
		case "missing field":
			if status != http.StatusBadRequest || !contains(body, `"invalid_request"`) {
				t.Fatalf("%s: status %d body %s, want 400 invalid_request", name, status, body)
			}
		default:
			if status != http.StatusBadRequest || !contains(body, `"invalid_display_name"`) {
				t.Fatalf("%s: status %d body %s, want 400 invalid_display_name", name, status, body)
			}
		}
	}
	if got := h.storedDisplayName(t, loginEmail); got != loginEmail {
		t.Fatalf("display name changed by a failed update: %q", got)
	}
}

func TestUpdateMeRequiresASession(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.rotationModule(t)

	status, body := doUpdateMe(t, handler, "", "Ghost Name")
	assertContractResponse(t, http.MethodPatch, "/identity/users/me", status, body)
	if status != http.StatusUnauthorized || !contains(body, `"unauthorized"`) {
		t.Fatalf("display-name update without token: status %d body %s, want 401 unauthorized", status, body)
	}
}
