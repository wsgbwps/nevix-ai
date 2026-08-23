// Mount-level tests for the Module's transport: Register is mounted through a
// chi Group exactly like the composition root, so the derived OPTIONS twins,
// the per-path Allow-Methods values, and the authz guards all behave as they
// will in production (the route-scoped middleware regression shape). No stack
// required: the guard rejects unauthenticated requests before any database
// work, and the public command's request-shape failure never reaches the
// service.
package identity

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/identity/auth"
	"github.com/nevix-ai/server/internal/identity/command"
)

// testModule builds a Module with nil pool dependencies: Register needs only
// the transport wiring, and no command here reaches the database.
func testModule() *Module {
	service := auth.NewService(nil, nil)
	return &Module{
		auth:        service,
		guard:       authz.NewGuard(service),
		corsOrigins: []string{"https://app.nevix.test"},
	}
}

func mountedRegister() http.Handler {
	router := chi.NewRouter()
	router.Group(func(r chi.Router) { testModule().Register(r, nil) })
	return router
}

func doMountedRequest(handler http.Handler, method, path, origin string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestRegisterDerivesPreflightSurfaceFromRouteTable(t *testing.T) {
	handler := mountedRegister()
	const whitelistedOrigin = "https://app.nevix.test"

	// Whitelisted preflight on every registered path: answered with 204, the
	// echoed origin, and the table-derived Allow-Methods — never reaching the
	// command.
	for path, wantMethods := range map[string]string{
		"/identity/auth/login":                    "POST, OPTIONS",
		"/identity/register":                      "POST, OPTIONS",
		"/identity/setup/status":                  "GET, OPTIONS",
		"/identity/setup/initialize":              "POST, OPTIONS",
		"/identity/auth/logout":                   "POST, OPTIONS",
		"/identity/auth/change-password":          "POST, OPTIONS",
		"/identity/users/me":                      "GET, PATCH, OPTIONS",
		"/identity/users":                         "GET, POST, OPTIONS",
		"/identity/admin/users":                   "GET, OPTIONS",
		"/identity/users/{userID}/disable":        "POST, OPTIONS",
		"/identity/users/{userID}/reset-password": "POST, OPTIONS",
		"/identity/users/{userID}/email":          "POST, OPTIONS",
		"/identity/users/{userID}/role":           "POST, OPTIONS",
		"/identity/audit-logs":                    "GET, OPTIONS",
	} {
		rec := doMountedRequest(handler, http.MethodOptions, path, whitelistedOrigin)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("%s preflight: status %d, want 204", path, rec.Code)
		}
		if got := rec.Header().Get("Access-Control-Allow-Methods"); got != wantMethods {
			t.Fatalf("%s preflight: Allow-Methods %q, want %q", path, got, wantMethods)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != whitelistedOrigin {
			t.Fatalf("%s preflight: Allow-Origin %q, want the whitelisted origin", path, got)
		}
	}

	// Unknown-origin preflight falls through to the OPTIONS twin: 204 without
	// any CORS headers, so the browser still enforces the denial.
	rec := doMountedRequest(handler, http.MethodOptions, "/identity/users/me", "https://evil.example")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("unknown-origin preflight: status %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unknown-origin preflight got Allow-Origin %q, want none", got)
	}
}

func TestDerivedPreflightMatchesParameterizedRoutePattern(t *testing.T) {
	const whitelistedOrigin = "https://app.nevix.test"
	routes := []command.Route{
		{Method: http.MethodPost, Path: "/identity/things/{thingID}", Guard: command.GuardPublic, Handler: func(http.ResponseWriter, *http.Request) {}},
		{Method: http.MethodDelete, Path: "/identity/things/{thingID}", Handler: func(http.ResponseWriter, *http.Request) {}},
	}
	router := chi.NewRouter()
	router.Group(func(r chi.Router) {
		r.Use(corsMiddleware([]string{whitelistedOrigin}, command.MethodsByPath(routes)))
		command.Mount(r, routes, command.Guards{
			ActiveUser: func(next http.Handler) http.Handler { return next },
			Admin:      func(next http.Handler) http.Handler { return next },
		})
	})

	rec := doMountedRequest(
		router,
		http.MethodOptions,
		"/identity/things/01K1ABCDEF",
		whitelistedOrigin,
	)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("parameterized preflight: status %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got != "POST, DELETE, OPTIONS" {
		t.Fatalf(
			"parameterized preflight: Allow-Methods %q, want %q",
			got,
			"POST, DELETE, OPTIONS",
		)
	}
}

func TestRegisterGuardsEveryRouteExceptThePublicEntries(t *testing.T) {
	handler := mountedRegister()

	// The guarded commands without a session never reach the handler: the
	// authz guard answers with the 401 envelope.
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/identity/auth/logout"},
		{http.MethodPost, "/identity/auth/change-password"},
		{http.MethodGet, "/identity/users/me"},
		{http.MethodPatch, "/identity/users/me"},
		{http.MethodGet, "/identity/users"},
		{http.MethodPost, "/identity/users"},
		{http.MethodGet, "/identity/admin/users"},
		{http.MethodPost, "/identity/users/01K1ABCDEF/disable"},
		{http.MethodPost, "/identity/users/01K1ABCDEF/reset-password"},
		{http.MethodPost, "/identity/users/01K1ABCDEF/email"},
		{http.MethodPost, "/identity/users/01K1ABCDEF/role"},
		{http.MethodDelete, "/identity/users/01K1ABCDEF"},
		{http.MethodGet, "/identity/audit-logs"},
	} {
		rec := doMountedRequest(handler, tc.method, tc.path, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s: status %d body %s, want 401", tc.method, tc.path, rec.Code, rec.Body.String())
		}
		if got := rec.Body.String(); !strings.Contains(got, `"unauthorized"`) {
			t.Fatalf("%s %s envelope %q, want unauthorized", tc.method, tc.path, got)
		}
	}

	// The public entry commands — login, join-code self-registration, and
	// setup initialize — reach their handlers without a session, which reject
	// the empty body with the request-shape 400 envelope. Setup status is
	// public too but carries no request body to validate; its behavior is
	// covered by the integration suite against the real database.
	for _, path := range []string{
		"/identity/auth/login",
		"/identity/register",
		"/identity/setup/initialize",
	} {
		rec := doMountedRequest(handler, http.MethodPost, path, "")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("public %s: status %d body %s, want 400", path, rec.Code, rec.Body.String())
		}
		if got := rec.Body.String(); !strings.Contains(got, `"invalid_request"`) {
			t.Fatalf("public %s envelope %q, want invalid_request", path, got)
		}
	}
}
