// Shared transport wiring and HTTP helpers for the command tests: mounts the
// Module exactly as the composition root mounts it (a chi Group, where
// group-scoped middleware runs only on matched routes), so tests assert only
// the HTTP contract and derived preflight twins behave as in production.
package integrationtest

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/nevix-ai/server/internal/event"
	"github.com/nevix-ai/server/internal/identity"
)

// moduleWithConfig constructs a Module on the runtime pool through the same
// seam as the composition root and mounts its routes.
func (h *harness) moduleWithConfig(t *testing.T, cfg identity.Config) (*identity.Module, http.Handler) {
	t.Helper()
	m, err := identity.NewModule(context.Background(), h.runtimePool, cfg)
	if err != nil {
		t.Fatalf("construct identity module: %v", err)
	}
	router := chi.NewRouter()
	router.Group(func(r chi.Router) { m.Register(r, event.NewInMemoryBus()) })
	return m, router
}

// commandRouter mounts a Module with the harness configuration.
func (h *harness) commandRouter(t *testing.T) http.Handler {
	t.Helper()
	_, handler := h.moduleWithConfig(t, h.cfg)
	return handler
}

// insertUser creates a user row through the owner credential with a real
// bcrypt hash, returning its id. Tests that need exact control over state
// bypass the module for fixture setup.
func (h *harness) insertUser(t *testing.T, email, password, role, status string, mustChangePassword bool) string {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash fixture password: %v", err)
	}
	var id string
	if err := h.fixturePool.QueryRow(context.Background(),
		`INSERT INTO public.users (email, password_hash, display_name, role, status, must_change_password)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		email, string(hash), email, role, status, mustChangePassword,
	).Scan(&id); err != nil {
		t.Fatalf("insert fixture user: %v", err)
	}
	return id
}

// loginBody is the login request shape.
func loginBody(email, password string) []byte {
	body, _ := json.Marshal(map[string]string{"email": email, "password": password, "device_name": "integration-test"})
	return body
}

// loginResponse is the login success shape.
type loginResponse struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
	User      struct {
		ID                 string `json:"id"`
		Email              string `json:"email"`
		DisplayName        string `json:"display_name"`
		Role               string `json:"role"`
		MustChangePassword bool   `json:"must_change_password"`
	} `json:"user"`
}

// doLogin posts a login and returns status, raw body, and the decoded success
// body when status is 200.
func doLogin(t *testing.T, handler http.Handler, email, password string) (int, []byte, loginResponse) {
	t.Helper()
	return doLoginFull(t, handler, loginBody(email, password))
}

func doLoginFull(t *testing.T, handler http.Handler, body []byte) (int, []byte, loginResponse) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/identity/auth/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	var decoded loginResponse
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("login 200 body is not the success shape: %v (%s)", err, rec.Body.String())
		}
	}
	return rec.Code, rec.Body.Bytes(), decoded
}

// doAuthenticated performs a bearer-authenticated request.
func doAuthenticated(t *testing.T, handler http.Handler, method, path, token string) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// doAuthenticatedJSON performs a bearer-authenticated request with a JSON
// body (the self-service write commands).
func doAuthenticatedJSON(t *testing.T, handler http.Handler, method, path, token string, body []byte) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// changePasswordBody is the change-password request shape.
func changePasswordBody(currentPassword, newPassword string) []byte {
	body, _ := json.Marshal(map[string]string{"current_password": currentPassword, "new_password": newPassword})
	return body
}

// displayNameBody is the PATCH /users/me request shape.
func displayNameBody(name string) []byte {
	body, _ := json.Marshal(map[string]string{"display_name": name})
	return body
}

// doChangePassword posts the change-password command with the given session
// token.
func doChangePassword(t *testing.T, handler http.Handler, token, currentPassword, newPassword string) (int, []byte) {
	t.Helper()
	return doAuthenticatedJSON(t, handler, http.MethodPost, "/identity/auth/change-password", token, changePasswordBody(currentPassword, newPassword))
}

// doUpdateMe patches the caller's display name.
func doUpdateMe(t *testing.T, handler http.Handler, token, displayName string) (int, []byte) {
	t.Helper()
	return doAuthenticatedJSON(t, handler, http.MethodPatch, "/identity/users/me", token, displayNameBody(displayName))
}

// doJSON performs a bearer-authenticated request with a JSON body; a nil
// body sends no body at all (guard rejections never read it).
func doJSON(t *testing.T, handler http.Handler, method, path, token string, body []byte) (int, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// doLogout posts the logout command with the given session token.
func doLogout(t *testing.T, handler http.Handler, token string) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/identity/auth/logout", bytes.NewReader([]byte("{}")))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// contains reports whether the raw body contains the exact JSON fragment.
func contains(body []byte, fragment string) bool {
	return bytes.Contains(body, []byte(fragment))
}
