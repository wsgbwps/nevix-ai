// Integration tests for the Bearer JWT transport foundation and the
// CreateOrganization command (identity-org-membership ticket 02): JWKS-based
// ES256 session verification with a uniform 401 envelope, the per-environment
// CORS whitelist, client-generated-id idempotency, the atomic organization +
// first Owner membership write through identity_app, and response-level
// conformance against contracts/openapi.yaml.
//
// The module is mounted exactly as the composition root mounts it; sessions
// are ES256 JWTs minted by a test key set against real GoTrue user ids, so
// verification runs on the same seam production uses while the command runs
// against the real database.
//
// Opt-in like the rest of the suite: requires the harness
// (scripts/test-mail-smoke.sh) to export the NEVIX_* variables.
package integrationtest

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/nevix-ai/server/internal/event"
	"github.com/nevix-ai/server/internal/identity"
)

// es256KeyServer publishes one ES256 key as a JWKS document and signs session
// JWTs with it — the test stand-in for the auth provider's key set.
type es256KeyServer struct {
	key    *ecdsa.PrivateKey
	kid    string
	server *httptest.Server
}

func newES256KeyServer(t *testing.T) *es256KeyServer {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate ES256 test key: %v", err)
	}
	ks := &es256KeyServer{key: key, kid: "transport-test-key"}
	ks.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "EC", "crv": "P-256", "use": "sig", "kid": ks.kid,
			"x": base64.RawURLEncoding.EncodeToString(key.X.Bytes()),
			"y": base64.RawURLEncoding.EncodeToString(key.Y.Bytes()),
		}}})
	}))
	t.Cleanup(ks.server.Close)
	return ks
}

// signToken mints an ES256 session JWT for the given user id.
func (ks *es256KeyServer) signToken(t *testing.T, sub string, exp time.Time) string {
	t.Helper()
	header, err := json.Marshal(map[string]string{"alg": "ES256", "typ": "JWT", "kid": ks.kid})
	if err != nil {
		t.Fatalf("marshal jwt header: %v", err)
	}
	payload, err := json.Marshal(map[string]any{"sub": sub, "exp": exp.Unix()})
	if err != nil {
		t.Fatalf("marshal jwt claims: %v", err)
	}
	signingInput := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	// ES256 signs the SHA-256 digest of the signing input, matching GoTrue's
	// issuance and the verifier in authjwt; ecdsa.Sign does not hash itself.
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, ks.key, digest[:])
	if err != nil {
		t.Fatalf("sign jwt: %v", err)
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
}

// newTransportHandler mounts the Module with the transport configuration
// pointed at the test key set and whitelist.
func newTransportHandler(t *testing.T, h *harness, jwksURL string, origins []string) http.Handler {
	t.Helper()
	cfg := h.cfg
	cfg.JWKSURL = jwksURL
	cfg.CORSAllowedOrigins = origins
	m, err := identity.NewModule(h.pool, cfg)
	if err != nil {
		t.Fatalf("construct identity module: %v", err)
	}
	// Mount through a chi Group exactly like the composition root: group-scoped
	// middleware runs only on matched routes, so mounting directly on the root
	// mux would hide preflight regressions production actually hits.
	router := chi.NewRouter()
	router.Group(func(r chi.Router) { m.Register(r, event.NewInMemoryBus()) })
	return router
}

// createOrganizationRequest posts the command and returns status, body, and
// headers so tests can also observe the CORS surface.
func createOrganizationRequest(handler http.Handler, token, id, name, origin string) (int, []byte, http.Header) {
	var bodyReader *strings.Reader
	if id != "" || name != "" {
		bodyReader = strings.NewReader(fmt.Sprintf(`{"id":%q,"name":%q}`, id, name))
	} else {
		bodyReader = strings.NewReader(`{`)
	}
	req := httptest.NewRequest(http.MethodPost, "/identity/organizations", bodyReader)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes(), rec.Header()
}

// organizationResponse decodes the 200 representation of the command.
type organizationResponse struct {
	Organization struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"organization"`
}

func TestCreateOrganizationBearerTransport(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	stack := newRLSStack(t, ctx)
	h := newHarness(t, ctx)

	owner := stack.signUpConfirmedUser(t, ctx, "create-org")
	other := stack.signUpConfirmedUser(t, ctx, "create-org-other")

	keys := newES256KeyServer(t)
	const whitelistedOrigin = "http://desktop.nevix.test"
	handler := newTransportHandler(t, h, keys.server.URL, []string{whitelistedOrigin})

	const path = "/identity/organizations"

	// JWT failures all collapse into the one documented 401 envelope.
	for name, token := range map[string]string{
		"missing bearer": "",
		"garbage token":  "not-a-jwt",
		"expired token":  keys.signToken(t, owner.ID, time.Now().Add(-time.Minute)),
	} {
		status, body, _ := createOrganizationRequest(handler, token, newRLSOrgID(t), "Denied Org", "")
		if status != http.StatusUnauthorized {
			t.Fatalf("%s: status %d body %s, want 401", name, status, body)
		}
		assertContractResponse(t, http.MethodPost, path, status, body)
	}

	// The command itself: create with a client-generated id.
	orgID := newRLSOrgID(t)
	token := keys.signToken(t, owner.ID, time.Now().Add(time.Hour))
	status, body, header := createOrganizationRequest(handler, token, orgID, "Transport Org", "")
	if status != http.StatusOK {
		t.Fatalf("create organization: status %d body %s, want 200", status, body)
	}
	var created organizationResponse
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatalf("create organization body is not JSON: %v", err)
	}
	if created.Organization.ID != orgID || created.Organization.Name != "Transport Org" {
		t.Fatalf("created organization %+v, want id %s name Transport Org", created.Organization, orgID)
	}
	if got := header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("origin-less request got Allow-Origin %q, want none", got)
	}
	assertContractResponse(t, http.MethodPost, path, status, body)

	// Atomicity: the organization row and exactly one active Owner membership
	// exist together after the single committed transaction.
	var orgRows, ownerRows int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM public.organizations WHERE id = $1`, orgID).Scan(&orgRows); err != nil {
		t.Fatalf("count organization rows: %v", err)
	}
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM public.memberships
		 WHERE organization_id = $1 AND role = 'owner' AND status = 'active'`, orgID,
	).Scan(&ownerRows); err != nil {
		t.Fatalf("count owner membership rows: %v", err)
	}
	if orgRows != 1 || ownerRows != 1 {
		t.Fatalf("after create: %d organization rows and %d active owner memberships, want 1 and 1", orgRows, ownerRows)
	}

	// Idempotent retry: same id by the same user returns the existing
	// organization and writes nothing new.
	status, body, _ = createOrganizationRequest(handler, token, orgID, "Transport Org", "")
	if status != http.StatusOK {
		t.Fatalf("idempotent retry: status %d body %s, want 200", status, body)
	}
	var retried organizationResponse
	if err := json.Unmarshal(body, &retried); err != nil {
		t.Fatalf("retry body is not JSON: %v", err)
	}
	if retried.Organization != created.Organization {
		t.Fatalf("retry returned %+v, want the existing organization %+v", retried.Organization, created.Organization)
	}
	assertContractResponse(t, http.MethodPost, path, status, body)
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM public.organizations WHERE id = $1`, orgID).Scan(&orgRows); err != nil {
		t.Fatalf("recount organization rows: %v", err)
	}
	if orgRows != 1 {
		t.Fatalf("retry created duplicates: %d organization rows for %s", orgRows, orgID)
	}

	// The same id by another user is a conflict, never a silent handover.
	otherToken := keys.signToken(t, other.ID, time.Now().Add(time.Hour))
	status, body, _ = createOrganizationRequest(handler, otherToken, orgID, "Stolen Org", "")
	if status != http.StatusConflict {
		t.Fatalf("conflicting id: status %d body %s, want 409", status, body)
	}
	assertContractResponse(t, http.MethodPost, path, status, body)

	// Request validation rejections.
	status, body, _ = createOrganizationRequest(handler, token, "not-a-uuid", "Bad Id Org", "")
	if status != http.StatusBadRequest {
		t.Fatalf("invalid id: status %d body %s, want 400", status, body)
	}
	assertContractResponse(t, http.MethodPost, path, status, body)
	status, body, _ = createOrganizationRequest(handler, token, newRLSOrgID(t), "   ", "")
	if status != http.StatusBadRequest {
		t.Fatalf("blank name: status %d body %s, want 400", status, body)
	}
	assertContractResponse(t, http.MethodPost, path, status, body)
}

func TestCreateOrganizationCORSWhitelist(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	keys := newES256KeyServer(t)

	const whitelistedOrigin = "http://desktop.nevix.test"
	handler := newTransportHandler(t, h, keys.server.URL, []string{whitelistedOrigin})

	// Whitelisted browser request: origin echoed exactly, never a wildcard.
	status, _, header := createOrganizationRequest(handler, "", newRLSOrgID(t), "CORS Org", whitelistedOrigin)
	if status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated CORS probe: status %d, want 401 (the request must still reach the guard)", status)
	}
	if got := header.Get("Access-Control-Allow-Origin"); got != whitelistedOrigin {
		t.Fatalf("whitelisted origin: Allow-Origin %q, want %q", got, whitelistedOrigin)
	}

	// Unknown origin: no CORS headers at all.
	_, _, header = createOrganizationRequest(handler, "", newRLSOrgID(t), "CORS Org", "https://evil.example")
	if got := header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unknown origin got Allow-Origin %q, want none", got)
	}

	// Whitelisted preflight is answered without touching the command.
	req := httptest.NewRequest(http.MethodOptions, "/identity/organizations", bytes.NewReader(nil))
	req.Header.Set("Origin", whitelistedOrigin)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("allowed preflight: status %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(got, "Authorization") {
		t.Fatalf("allowed preflight: Allow-Headers %q, want Authorization for the Bearer scheme", got)
	}

	// Unknown-origin preflight: answered without CORS headers, so the browser
	// still enforces the denial.
	req = httptest.NewRequest(http.MethodOptions, "/identity/organizations", bytes.NewReader(nil))
	req.Header.Set("Origin", "https://evil.example")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unknown preflight got Allow-Origin %q, want no CORS headers", got)
	}

	// The verification-code command exposes the same preflight surface.
	req = httptest.NewRequest(http.MethodOptions, "/identity/verification-codes", bytes.NewReader(nil))
	req.Header.Set("Origin", whitelistedOrigin)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("verification-code preflight: status %d, want 204", rec.Code)
	}
}
