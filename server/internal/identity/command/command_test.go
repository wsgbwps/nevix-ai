// Unit tests for the trusted-command skeleton: the shared pipeline (decode →
// Validate → domain error mapping → envelope), the route table machinery,
// and the derived OPTIONS twins. No stack required.
package command_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/identity/command"
)

var errRateLimited = errors.New("rate limited")

type echoRequest struct {
	Value string `json:"value"`
}

type echoResponse struct {
	Value string `json:"value"`
}

// validatedRequest exercises the optional Validate hook: normalization runs
// before the check, and the returned Error shapes the response directly.
type validatedRequest struct {
	Email string `json:"email"`
}

func (r *validatedRequest) Validate() *command.Error {
	r.Email = strings.ToLower(strings.TrimSpace(r.Email))
	if r.Email == "" {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_email", Message: "email must not be blank."}
	}
	return nil
}

func noMapError(error) *command.Error { return nil }

func servePipeline(handler http.HandlerFunc, method, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(method, "/commands/echo", strings.NewReader(body)))
	return rec
}

func TestPipelineDecodeFailureWritesInvalidRequestEnvelope(t *testing.T) {
	handler := command.Handle(func(ctx context.Context, req echoRequest) (echoResponse, error) {
		return echoResponse{}, nil
	}, noMapError, http.StatusAccepted)

	rec := servePipeline(handler, http.MethodPost, "{")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}
	want := `{"error":"invalid_request","message":"Request body must be JSON."}`
	if got := rec.Body.String(); got != want {
		t.Fatalf("envelope %q, want the exact byte shape %q", got, want)
	}
}

func TestPipelineValidateFailureShapesResponseFromError(t *testing.T) {
	handler := command.Handle(func(ctx context.Context, req validatedRequest) (echoResponse, error) {
		return echoResponse{Value: req.Email}, nil
	}, noMapError, http.StatusOK)

	rec := servePipeline(handler, http.MethodPost, `{"email":"  "}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}
	if got := rec.Body.String(); !strings.Contains(got, `"invalid_email"`) {
		t.Fatalf("envelope %q, want invalid_email", got)
	}
}

func TestPipelineValidateNormalizesBeforeCheck(t *testing.T) {
	handler := command.Handle(func(ctx context.Context, req validatedRequest) (echoResponse, error) {
		return echoResponse{Value: req.Email}, nil
	}, noMapError, http.StatusOK)

	rec := servePipeline(handler, http.MethodPost, `{"email":"  USER@EXAMPLE.COM  "}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s, want 200", rec.Code, rec.Body.String())
	}
	var got echoResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	if got.Value != "user@example.com" {
		t.Fatalf("business saw %q, want the normalized lowercase address", got.Value)
	}
}

func TestPipelineDomainErrorMapsWithHeaders(t *testing.T) {
	mapError := func(err error) *command.Error {
		if errors.Is(err, errRateLimited) {
			return &command.Error{
				Status:  http.StatusTooManyRequests,
				Code:    "cooldown_active",
				Message: "A code was sent less than 60 seconds ago.",
				Headers: map[string]string{"Retry-After": "42"},
			}
		}
		return nil
	}
	handler := command.Handle(func(ctx context.Context, req echoRequest) (echoResponse, error) {
		return echoResponse{}, errRateLimited
	}, mapError, http.StatusAccepted)

	rec := servePipeline(handler, http.MethodPost, `{"value":"x"}`)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d, want 429", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "42" {
		t.Fatalf("Retry-After %q, want 42", got)
	}
	if got := rec.Body.String(); !strings.Contains(got, `"cooldown_active"`) {
		t.Fatalf("envelope %q, want cooldown_active", got)
	}
}

func TestPipelineUnknownErrorLogsAndReturnsInternalError(t *testing.T) {
	var logs bytes.Buffer
	original := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(original) })

	handler := command.Handle(func(ctx context.Context, req echoRequest) (echoResponse, error) {
		return echoResponse{}, errors.New("boom")
	}, noMapError, http.StatusOK)

	rec := servePipeline(handler, http.MethodPost, `{"value":"x"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", rec.Code)
	}
	if got := rec.Body.String(); !strings.Contains(got, `"internal_error"`) {
		t.Fatalf("envelope %q, want internal_error", got)
	}
	if !strings.Contains(logs.String(), "boom") {
		t.Fatalf("logs %q, want the unmapped error recorded", logs.String())
	}
}

func TestPipelineSuccessWritesDeclaredStatusAndJSON(t *testing.T) {
	handler := command.Handle(func(ctx context.Context, req echoRequest) (echoResponse, error) {
		return echoResponse{Value: req.Value}, nil
	}, noMapError, http.StatusAccepted)

	rec := servePipeline(handler, http.MethodPost, `{"value":"hello"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status %d, want 202", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type %q, want application/json", got)
	}
	var got echoResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	if got.Value != "hello" {
		t.Fatalf("response %+v, want value hello", got)
	}
}

func TestHandleWithRequestExposesTheRequest(t *testing.T) {
	handler := command.HandleWithRequest(func(ctx context.Context, r *http.Request, req echoRequest) (echoResponse, error) {
		return echoResponse{Value: r.RemoteAddr}, nil
	}, noMapError, http.StatusOK)

	req := httptest.NewRequest(http.MethodPost, "/commands/echo", strings.NewReader(`{}`))
	req.RemoteAddr = "10.0.0.1:43210"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	var got echoResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	if got.Value != "10.0.0.1:43210" {
		t.Fatalf("business saw %q, want the request's remote address", got.Value)
	}
}

func TestMethodsByPathAggregatesPerPath(t *testing.T) {
	routes := []command.Route{
		{Method: http.MethodGet, Path: "/commands/resource", Handler: nil},
		{Method: http.MethodDelete, Path: "/commands/resource", Handler: nil},
		{Method: http.MethodPost, Path: "/commands/other", Handler: nil},
	}
	got := command.MethodsByPath(routes)
	want := map[string][]string{
		"/commands/resource": {http.MethodGet, http.MethodDelete},
		"/commands/other":    {http.MethodPost},
	}
	if len(got) != len(want) {
		t.Fatalf("MethodsByPath %v, want %v", got, want)
	}
	for path, methods := range want {
		if !slices.Equal(got[path], methods) {
			t.Fatalf("MethodsByPath[%s] = %v, want %v", path, got[path], methods)
		}
	}
}

func TestAllowMethodsDerivesFromTable(t *testing.T) {
	methods := map[string][]string{
		"/commands/resource": {http.MethodGet, http.MethodDelete},
		"/commands/other":    {http.MethodPost},
	}
	for _, tc := range []struct {
		path, want string
	}{
		{"/commands/resource", "GET, DELETE, OPTIONS"},
		{"/commands/other", "POST, OPTIONS"},
		{"/commands/unknown", "OPTIONS"},
	} {
		if got := command.AllowMethods(methods, tc.path); got != tc.want {
			t.Fatalf("AllowMethods(%s) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestMountGuardsRoutesByDeclaredPolicyAndRegistersPreflightTwins(t *testing.T) {
	var activeUserCalls, adminCalls []string
	record := func(calls *[]string) func(http.Handler) http.Handler {
		return func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				*calls = append(*calls, r.Method+" "+r.URL.Path)
				next.ServeHTTP(w, r)
			})
		}
	}
	ok := func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }
	routes := []command.Route{
		{Method: http.MethodPost, Path: "/commands/default", Handler: ok},
		{Method: http.MethodPost, Path: "/commands/public", Guard: command.GuardPublic, Handler: ok},
		{Method: http.MethodPost, Path: "/commands/admin", Guard: command.GuardAdmin, Handler: ok},
		{Method: http.MethodDelete, Path: "/commands/admin", Guard: command.GuardAdmin, Handler: ok},
	}
	router := chi.NewRouter()
	router.Group(func(r chi.Router) {
		command.Mount(r, routes, command.Guards{ActiveUser: record(&activeUserCalls), Admin: record(&adminCalls)})
	})

	do := func(method, path string) int {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
		return rec.Code
	}
	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{http.MethodPost, "/commands/default", http.StatusOK},
		{http.MethodPost, "/commands/public", http.StatusOK},
		{http.MethodPost, "/commands/admin", http.StatusOK},
		{http.MethodDelete, "/commands/admin", http.StatusOK},
	} {
		if got := do(tc.method, tc.path); got != tc.want {
			t.Fatalf("%s %s: status %d, want %d", tc.method, tc.path, got, tc.want)
		}
	}
	// The zero-value guard is RequireActiveUser: an undeclared route is an
	// authenticated route, and only the declared public route bypasses it.
	if want := []string{"POST /commands/default"}; !slices.Equal(activeUserCalls, want) {
		t.Fatalf("ActiveUser saw %v, want only the default-guard route %v", activeUserCalls, want)
	}
	if want := []string{"POST /commands/admin", "DELETE /commands/admin"}; !slices.Equal(adminCalls, want) {
		t.Fatalf("Admin saw %v, want %v", adminCalls, want)
	}

	// Every path gets its OPTIONS twin, answered without reaching a guard.
	for _, path := range []string{"/commands/default", "/commands/public", "/commands/admin"} {
		if got := do(http.MethodOptions, path); got != http.StatusNoContent {
			t.Fatalf("OPTIONS %s: status %d, want 204", path, got)
		}
	}
}

func TestMountPanicsWhenAGuardedRouteLacksItsMiddleware(t *testing.T) {
	ok := func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }
	defer func() {
		if recover() == nil {
			t.Fatal("Mount accepted an admin route without the Admin middleware")
		}
	}()
	command.Mount(chi.NewRouter(), []command.Route{
		{Method: http.MethodGet, Path: "/commands/admin", Guard: command.GuardAdmin, Handler: ok},
	}, command.Guards{})
}

// principalInjector stands in for a guard: it resolves a fixed principal so
// the password gate nested inside it can be exercised without a database.
func principalInjector(principal authz.Principal) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(authz.WithPrincipal(r.Context(), principal)))
		})
	}
}

func TestMountEnforcesPasswordGateByDeclaredPolicy(t *testing.T) {
	reached := func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }
	flagged := authz.Principal{UserID: "u1", Role: "member", MustChangePassword: true}
	settled := authz.Principal{UserID: "u1", Role: "member"}

	mount := func(principal authz.Principal) http.Handler {
		routes := []command.Route{
			{Method: http.MethodPost, Path: "/commands/business", Handler: reached},
			{Method: http.MethodPost, Path: "/commands/auth-scoped", PasswordGate: command.PasswordGateOpen, Handler: reached},
		}
		router := chi.NewRouter()
		router.Group(func(r chi.Router) {
			command.Mount(r, routes, command.Guards{
				ActiveUser: principalInjector(principal),
				Admin:      principalInjector(principal),
			})
		})
		return router
	}

	do := func(handler http.Handler, path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, nil))
		return rec
	}

	// While the forced change is owed, the zero-value policy blocks the
	// business route before its handler; the declared-open route runs.
	gated := mount(flagged)
	if rec := do(gated, "/commands/business"); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"password_change_required"`) {
		t.Fatalf("business route while change owed: status %d body %s, want 403 password_change_required", rec.Code, rec.Body.String())
	}
	if rec := do(gated, "/commands/auth-scoped"); rec.Code != http.StatusOK {
		t.Fatalf("auth-scoped route while change owed: status %d body %s, want 200", rec.Code, rec.Body.String())
	}

	// Once the change is done, the same routes all run.
	settledHandler := mount(settled)
	for _, path := range []string{"/commands/business", "/commands/auth-scoped"} {
		if rec := do(settledHandler, path); rec.Code != http.StatusOK {
			t.Fatalf("%s after change completed: status %d body %s, want 200", path, rec.Code, rec.Body.String())
		}
	}
}
