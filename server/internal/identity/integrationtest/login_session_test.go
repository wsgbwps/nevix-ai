// Login, session lifecycle, and the /users/me read (issue #100): opaque
// tokens stored only as hashes, multi-device independence, 30-day sliding
// expiry, logout revoking exactly one session, sessions surviving a server
// restart, login failure rate limiting, and the audit rows riding the same
// write transactions.
package integrationtest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/identity"
)

const (
	loginEmail    = "admin@nevix.test"
	loginPassword = "correct-password-1"
)

// loginReadyModule resets state, creates an active user through the owner
// credential, and returns a module + router constructed afterwards (so the
// module's limiter is fresh and bootstrap is inert).
func (h *harness) loginReadyModule(t *testing.T) (*identity.Module, http.Handler) {
	t.Helper()
	h.resetUserState(t)
	h.insertUser(t, loginEmail, loginPassword, "admin", "active", false)
	cfg := h.cfg
	cfg.AdminEmail = ""
	cfg.AdminInitialPassword = ""
	return h.moduleWithConfig(t, cfg)
}

func sessionCount(t *testing.T, h *harness) int {
	t.Helper()
	var count int
	if err := h.fixturePool.QueryRow(context.Background(), `SELECT count(*) FROM public.sessions`).Scan(&count); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	return count
}

func TestLoginIssuesOpaqueSessionStoredOnlyAsHash(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.loginReadyModule(t)

	status, body, login := doLogin(t, handler, loginEmail, loginPassword)
	assertContractResponse(t, http.MethodPost, "/identity/auth/login", status, body)
	if status != http.StatusOK {
		t.Fatalf("login: status %d body %s", status, body)
	}
	if login.Token == "" {
		t.Fatal("login response carries no token")
	}
	if login.User.Email != loginEmail || login.User.Role != "admin" || login.User.MustChangePassword {
		t.Fatalf("login user payload = %+v, want the fixture admin without a pending change", login.User)
	}
	if remaining := time.Until(login.ExpiresAt); remaining < 29*24*time.Hour || remaining > 31*24*time.Hour {
		t.Fatalf("session expiry %v away, want ~30 days", remaining)
	}

	// The server stores only the SHA-256 hash; the token bytes never persist.
	if got := sessionCount(t, h); got != 1 {
		t.Fatalf("sessions after login = %d, want 1", got)
	}
	digest := sha256.Sum256([]byte(login.Token))
	var storedHash string
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT encode(token_hash, 'hex') FROM public.sessions`,
	).Scan(&storedHash); err != nil {
		t.Fatalf("read stored token hash: %v", err)
	}
	if storedHash != hex.EncodeToString(digest[:]) {
		t.Fatal("stored session hash is not the SHA-256 of the issued token")
	}
	if storedHash == hex.EncodeToString([]byte(login.Token)) {
		t.Fatal("session token stored in plaintext")
	}
	if actions := h.auditActions(t); len(actions) != 1 || actions[0] != "session_created" {
		t.Fatalf("audit actions after login = %v, want exactly session_created", actions)
	}
}

func TestLoginRejectsBadCredentialsUniformly(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.loginReadyModule(t)

	// Wrong password and unknown email answer identically: no enumeration.
	for name, email := range map[string]string{
		"wrong password": loginEmail,
		"unknown email":  "nobody@nevix.test",
	} {
		status, body, _ := doLogin(t, handler, email, "wrong-password")
		assertContractResponse(t, http.MethodPost, "/identity/auth/login", status, body)
		if status != http.StatusUnauthorized {
			t.Fatalf("%s: status %d body %s, want 401", name, status, body)
		}
		if want := `"invalid_credentials"`; !contains(body, want) {
			t.Fatalf("%s: body %s lacks %s", name, body, want)
		}
	}
	// Shape failures are 400 and never touch the limiter.
	status, body, _ := doLoginFull(t, handler, []byte(`{"email":"not-an-email","password":"x"}`))
	assertContractResponse(t, http.MethodPost, "/identity/auth/login", status, body)
	if status != http.StatusBadRequest {
		t.Fatalf("malformed email: status %d body %s, want 400", status, body)
	}

	// A body missing a required field, or a JSON null body, is invalid_request:
	// the contract's shape rule, not a credential failure.
	for name, payload := range map[string][]byte{
		"missing password":      []byte(`{"email":"` + loginEmail + `"}`),
		"missing email":         []byte(`{"password":"x"}`),
		"null body":             []byte(`null`),
		"non-object body":       []byte(`["email"]`),
		"empty password string": []byte(`{"email":"` + loginEmail + `","password":""}`),
	} {
		status, body, _ := doLoginFull(t, handler, payload)
		assertContractResponse(t, http.MethodPost, "/identity/auth/login", status, body)
		switch name {
		case "empty password string":
			// Present-but-empty is a credential failure, not a shape failure.
			if status != http.StatusUnauthorized || !contains(body, `"invalid_credentials"`) {
				t.Fatalf("%s: status %d body %s, want 401 invalid_credentials", name, status, body)
			}
		default:
			if status != http.StatusBadRequest || !contains(body, `"invalid_request"`) {
				t.Fatalf("%s: status %d body %s, want 400 invalid_request", name, status, body)
			}
		}
	}
}

func TestLoginAnswersDisabledAccountWithAccountDisabled(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	h.resetUserState(t)
	h.insertUser(t, loginEmail, loginPassword, "member", "disabled", false)
	cfg := h.cfg
	cfg.AdminEmail = ""
	cfg.AdminInitialPassword = ""
	_, handler := h.moduleWithConfig(t, cfg)

	status, body, _ := doLogin(t, handler, loginEmail, loginPassword)
	assertContractResponse(t, http.MethodPost, "/identity/auth/login", status, body)
	if status != http.StatusForbidden {
		t.Fatalf("disabled login: status %d body %s, want 403", status, body)
	}
	if !contains(body, `"account_disabled"`) {
		t.Fatalf("disabled login body %s, want account_disabled", body)
	}
	if got := sessionCount(t, h); got != 0 {
		t.Fatalf("disabled login created %d sessions", got)
	}
}

func TestLoginRateLimitsAfterWindowedFailures(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	// One module instance: the in-process limiter state must accumulate
	// across requests, so this test cannot rebuild the router per attempt.
	_, handler := h.loginReadyModule(t)

	for attempt := 0; attempt < 5; attempt++ {
		status, _, _ := doLogin(t, handler, loginEmail, "wrong-password")
		if status != http.StatusUnauthorized {
			t.Fatalf("failure attempt %d: status %d, want 401", attempt+1, status)
		}
	}
	// Even the correct password is locked out now, with a Retry-After header.
	req := httptest.NewRequest(http.MethodPost, "/identity/auth/login", bytes.NewReader(loginBody(loginEmail, loginPassword)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assertContractResponse(t, http.MethodPost, "/identity/auth/login", rec.Code, rec.Body.Bytes())
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("locked-out login: status %d body %s, want 429", rec.Code, rec.Body.String())
	}
	if !contains(rec.Body.Bytes(), `"login_rate_limited"`) {
		t.Fatalf("locked-out body %s, want login_rate_limited", rec.Body.String())
	}
	retryAfter, err := strconv.Atoi(rec.Header().Get("Retry-After"))
	if err != nil || retryAfter <= 0 {
		t.Fatalf("Retry-After header %q, want a positive integer", rec.Header().Get("Retry-After"))
	}
	if got := sessionCount(t, h); got != 0 {
		t.Fatalf("locked-out attempts created %d sessions", got)
	}

	// A different email is unaffected by this email's lockout.
	h.insertUser(t, "other@nevix.test", "other-password-1", "member", "active", false)
	status, body, _ := doLogin(t, handler, "other@nevix.test", "other-password-1")
	if status != http.StatusOK {
		t.Fatalf("unrelated email after lockout: status %d body %s", status, body)
	}
}

func TestLoginFailureCountClearsOnSuccess(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.loginReadyModule(t)

	for attempt := 0; attempt < 4; attempt++ {
		doLogin(t, handler, loginEmail, "wrong-password")
	}
	if status, _, _ := doLogin(t, handler, loginEmail, loginPassword); status != http.StatusOK {
		t.Fatalf("successful login after 4 failures: status %d, want 200", status)
	}
	// The counter restarted: five more failures are needed for lockout.
	for attempt := 0; attempt < 4; attempt++ {
		doLogin(t, handler, loginEmail, "wrong-password")
	}
	if status, _, _ := doLogin(t, handler, loginEmail, loginPassword); status != http.StatusOK {
		t.Fatalf("login after cleared counter: status %d, want 200 (failures restarted)", status)
	}
}

func TestMeRequiresASessionAndReturnsOwnAccount(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.loginReadyModule(t)

	status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", "")
	assertContractResponse(t, http.MethodGet, "/identity/users/me", status, body)
	if status != http.StatusUnauthorized {
		t.Fatalf("me without token: status %d body %s, want 401", status, body)
	}

	status, _, login := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("login: status %d", status)
	}
	status, body = doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", login.Token)
	assertContractResponse(t, http.MethodGet, "/identity/users/me", status, body)
	if status != http.StatusOK {
		t.Fatalf("me with token: status %d body %s", status, body)
	}
	if !contains(body, `"email":"`+loginEmail+`"`) || !contains(body, `"role":"admin"`) {
		t.Fatalf("me body %s, want the login account", body)
	}
}

func TestLogoutRevokesOnlyTheCallingSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.loginReadyModule(t)

	status, _, first := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("first login: status %d", status)
	}
	status, _, second := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("second login: status %d", status)
	}
	if first.Token == second.Token {
		t.Fatal("two logins issued the same token; sessions are not independent")
	}
	if got := sessionCount(t, h); got != 2 {
		t.Fatalf("sessions for two devices = %d, want 2", got)
	}

	status, body := doLogout(t, handler, first.Token)
	assertContractResponse(t, http.MethodPost, "/identity/auth/logout", status, body)
	if status != http.StatusOK {
		t.Fatalf("logout: status %d body %s", status, body)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", first.Token); status != http.StatusUnauthorized {
		t.Fatalf("me after logout: status %d body %s, want 401", status, body)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", second.Token); status != http.StatusOK {
		t.Fatalf("other device after logout: status %d body %s, want 200 (only the calling session ends)", status, body)
	}
	if got := sessionCount(t, h); got != 1 {
		t.Fatalf("sessions after one logout = %d, want 1", got)
	}
	if actions := h.auditActions(t); len(actions) != 3 || actions[2] != "session_revoked" {
		t.Fatalf("audit actions = %v, want two logins then session_revoked", actions)
	}

	// Repeat logout answers 401: the guard rejects the already-revoked token
	// before the command runs, so a dead session can never re-revoke itself.
	if status, body := doLogout(t, handler, first.Token); status != http.StatusUnauthorized {
		t.Fatalf("repeat logout: status %d body %s, want 401", status, body)
	}
}

func TestSessionSurvivesModuleReconstruction(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, firstHandler := h.loginReadyModule(t)
	status, _, login := doLogin(t, firstHandler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("login: status %d", status)
	}

	// A reconstructed Module is a restarted process: session truth lives in
	// PostgreSQL, never in memory.
	cfg := h.cfg
	cfg.AdminEmail = ""
	cfg.AdminInitialPassword = ""
	_, restartedHandler := h.moduleWithConfig(t, cfg)
	status, body := doAuthenticated(t, restartedHandler, http.MethodGet, "/identity/users/me", login.Token)
	if status != http.StatusOK {
		t.Fatalf("me after restart: status %d body %s, want 200", status, body)
	}
}

func TestSessionSlidingExpiryRefreshesOnUse(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.loginReadyModule(t)
	status, _, login := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("login: status %d", status)
	}

	// Move the session near expiry (under the refresh threshold) and use it.
	digest := sha256.Sum256([]byte(login.Token))
	if _, err := h.fixturePool.Exec(ctx,
		`UPDATE public.sessions SET expires_at = now() + interval '2 days' WHERE token_hash = $1`, digest[:],
	); err != nil {
		t.Fatalf("age session: %v", err)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", login.Token); status != http.StatusOK {
		t.Fatalf("me on nearly-expired session: status %d body %s", status, body)
	}

	var expiresAt time.Time
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT expires_at FROM public.sessions WHERE token_hash = $1`, digest[:],
	).Scan(&expiresAt); err != nil {
		t.Fatalf("read refreshed expiry: %v", err)
	}
	if remaining := time.Until(expiresAt); remaining < 29*24*time.Hour {
		t.Fatalf("expiry after use %v away, want the sliding window re-armed to ~30 days", remaining)
	}
}

func TestExpiredSessionIsRejected(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	_, handler := h.loginReadyModule(t)
	status, _, login := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("login: status %d", status)
	}

	digest := sha256.Sum256([]byte(login.Token))
	if _, err := h.fixturePool.Exec(ctx,
		`UPDATE public.sessions SET expires_at = now() - interval '1 hour' WHERE token_hash = $1`, digest[:],
	); err != nil {
		t.Fatalf("expire session: %v", err)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", login.Token); status != http.StatusUnauthorized {
		t.Fatalf("me on expired session: status %d body %s, want 401", status, body)
	}
}

func TestSweepDeletesExpiredSessions(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	m, handler := h.loginReadyModule(t)
	status, _, login := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("login: status %d", status)
	}

	// One live row plus one expired row; only the expired row may vanish.
	h.insertUser(t, "other@nevix.test", "other-password-1", "member", "active", false)
	if _, err := h.fixturePool.Exec(ctx,
		`INSERT INTO public.sessions (user_id, token_hash, device_name, expires_at)
		 SELECT id, decode('deadbeef','hex'), 'expired-device', now() - interval '1 hour'
		 FROM public.users WHERE email = 'other@nevix.test'`); err != nil {
		t.Fatalf("insert expired session: %v", err)
	}
	if got := sessionCount(t, h); got != 2 {
		t.Fatalf("sessions before sweep = %d, want 2", got)
	}

	h.startWorkers(t, m) // runs the sweep immediately
	deadline := time.Now().Add(10 * time.Second)
	for sessionCount(t, h) == 2 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if got := sessionCount(t, h); got != 1 {
		t.Fatalf("sessions after sweep = %d, want 1 (only the live session)", got)
	}
	if status, body := doAuthenticated(t, handler, http.MethodGet, "/identity/users/me", login.Token); status != http.StatusOK {
		t.Fatalf("live session after sweep: status %d body %s", status, body)
	}
}

func TestSweepDeletesAuditRowsPastRetention(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	m, handler := h.loginReadyModule(t)
	status, _, login := doLogin(t, handler, loginEmail, loginPassword)
	if status != http.StatusOK {
		t.Fatalf("login: status %d", status)
	}

	// One audit row inside the retention window (the login) plus one a year
	// and a day old; the sweep keeps the recent and deletes only the stale.
	if _, err := h.fixturePool.Exec(ctx,
		`INSERT INTO public.audit_logs (actor_user_id, actor_display_name, action, metadata, created_at)
		 VALUES ($1, 'ghost', 'session_created', '{}'::jsonb, now() - interval '366 days')`,
		login.User.ID,
	); err != nil {
		t.Fatalf("insert stale audit row: %v", err)
	}

	h.startWorkers(t, m) // runs the sweep immediately
	deadline := time.Now().Add(10 * time.Second)
	for len(h.auditActions(t)) == 2 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if actions := h.auditActions(t); len(actions) != 1 || actions[0] != "session_created" {
		t.Fatalf("audit actions after sweep = %v, want only the in-window login row", actions)
	}
}
