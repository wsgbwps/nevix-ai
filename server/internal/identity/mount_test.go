// Mount-level tests for the Module's transport: Register is mounted through a
// chi Group exactly like the composition root, so the derived OPTIONS twins,
// the per-path Allow-Methods values, and the Bearer guard all behave as they
// will in production (the route-scoped middleware regression shape). No stack
// required.
package identity

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/nevix-ai/server/internal/identity/authjwt"
	"github.com/nevix-ai/server/internal/identity/organizations"
	"github.com/nevix-ai/server/internal/identity/verification"
)

// testModule builds a Module with nil pool dependencies: Register needs only
// the transport wiring, and no command here reaches the database.
func testModule() *Module {
	return &Module{
		issuer:      verification.NewCodeIssuer(nil, verification.CodeIssuanceConfig{}),
		orgs:        organizations.NewCreator(nil),
		verifier:    authjwt.NewVerifier("https://auth.nevix.test/.well-known/jwks.json"),
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
	for _, path := range []string{"/identity/verification-codes", "/identity/organizations"} {
		rec := doMountedRequest(handler, http.MethodOptions, path, whitelistedOrigin)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("%s preflight: status %d, want 204", path, rec.Code)
		}
		if got := rec.Header().Get("Access-Control-Allow-Methods"); got != "POST, OPTIONS" {
			t.Fatalf("%s preflight: Allow-Methods %q, want %q", path, got, "POST, OPTIONS")
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != whitelistedOrigin {
			t.Fatalf("%s preflight: Allow-Origin %q, want the whitelisted origin", path, got)
		}
	}

	// Unknown-origin preflight falls through to the OPTIONS twin: 204 without
	// any CORS headers, so the browser still enforces the denial.
	rec := doMountedRequest(handler, http.MethodOptions, "/identity/organizations", "https://evil.example")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("unknown-origin preflight: status %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unknown-origin preflight got Allow-Origin %q, want none", got)
	}
}

func TestRegisterGuardsOnlyPrivateRoutes(t *testing.T) {
	handler := mountedRegister()

	// The private command without a token never reaches the handler: the
	// Bearer guard answers with the 401 envelope.
	rec := doMountedRequest(handler, http.MethodPost, "/identity/organizations", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("private command: status %d body %s, want 401", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); !strings.Contains(got, `"unauthorized"`) {
		t.Fatalf("private command envelope %q, want unauthorized", got)
	}

	// The public command without a token reaches the handler, which rejects
	// the empty body with the request-shape 400 envelope.
	rec = doMountedRequest(handler, http.MethodPost, "/identity/verification-codes", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("public command: status %d body %s, want 400", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); !strings.Contains(got, `"invalid_request"`) {
		t.Fatalf("public command envelope %q, want invalid_request", got)
	}
}
