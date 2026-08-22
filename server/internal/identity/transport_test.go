// Unit tests for the Module's transport foundation: the environment CORS
// whitelist (requests without an Origin pass, whitelisted origins are echoed
// exactly, nothing else ever gets CORS headers, never a wildcard) and the
// transport deployment configuration. No stack required.
package identity

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func corsHandler(origins []string, methodsByPath map[string][]string) http.Handler {
	return corsMiddleware(origins, methodsByPath)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
}

func doCORS(handler http.Handler, method, origin string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/identity/auth/login", nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestCORSWhitelistEchoesAllowedOriginsExactly(t *testing.T) {
	handler := corsHandler([]string{"https://app.nevix.test", "http://127.0.0.1:5173"}, nil)

	rec := doCORS(handler, http.MethodPost, "https://app.nevix.test")
	if rec.Code != http.StatusOK {
		t.Fatalf("whitelisted origin: status %d, want the request to reach the handler", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://app.nevix.test" {
		t.Fatalf("whitelisted origin: Allow-Origin %q, want the origin echoed exactly", got)
	}
	if got := rec.Header().Get("Access-Control-Expose-Headers"); !strings.Contains(got, "Retry-After") {
		t.Fatalf("whitelisted origin: Expose-Headers %q, want the rate-limit Retry-After header", got)
	}
}

func TestCORSRejectsUnknownOriginsWithoutHeaders(t *testing.T) {
	handler := corsHandler([]string{"https://app.nevix.test"}, nil)

	rec := doCORS(handler, http.MethodPost, "https://evil.example")
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unknown origin got Allow-Origin %q, want no CORS headers at all", got)
	}
	if got := rec.Header().Get("Access-Control-Expose-Headers"); got != "" {
		t.Fatalf("unknown origin got Expose-Headers %q, want no CORS headers at all", got)
	}
}

func TestCORSPassesRequestsWithoutOrigin(t *testing.T) {
	handler := corsHandler([]string{"https://app.nevix.test"}, nil)

	rec := doCORS(handler, http.MethodPost, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("origin-less request: status %d, want it to reach the handler", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("origin-less request got Allow-Origin %q, want none", got)
	}
	if got := rec.Header().Get("Access-Control-Expose-Headers"); got != "" {
		t.Fatalf("origin-less request got Expose-Headers %q, want none", got)
	}
}

func TestCORSPreflightServesAllowedOriginsOnly(t *testing.T) {
	handler := corsHandler([]string{"https://app.nevix.test"}, map[string][]string{"/identity/auth/login": {http.MethodPost}})

	rec := doCORS(handler, http.MethodOptions, "https://app.nevix.test")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("allowed preflight: status %d, want 204 without reaching the handler", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(got, http.MethodPost) {
		t.Fatalf("allowed preflight: Allow-Methods %q, want POST", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(got, "Authorization") {
		t.Fatalf("allowed preflight: Allow-Headers %q, want Authorization for the Bearer scheme", got)
	}

	rec = doCORS(handler, http.MethodOptions, "https://evil.example")
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unknown preflight got Allow-Origin %q, want no CORS headers", got)
	}
}

func fullTransportEnv(overrides map[string]string) func(string) string {
	values := map[string]string{
		"CORS_ALLOWED_ORIGINS": "https://app.nevix.test,http://127.0.0.1:5173",
	}
	for key, value := range overrides {
		values[key] = value
	}
	return func(key string) string { return values[key] }
}

func TestLoadConfigParsesTransportVariables(t *testing.T) {
	cfg, err := LoadConfig(fullTransportEnv(nil))
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	want := []string{"https://app.nevix.test", "http://127.0.0.1:5173"}
	if len(cfg.CORSAllowedOrigins) != len(want) {
		t.Fatalf("CORSAllowedOrigins %v, want %v", cfg.CORSAllowedOrigins, want)
	}
	for i := range want {
		if cfg.CORSAllowedOrigins[i] != want[i] {
			t.Fatalf("CORSAllowedOrigins %v, want %v", cfg.CORSAllowedOrigins, want)
		}
	}
}

func TestLoadConfigCarriesBootstrapVariablesVerbatim(t *testing.T) {
	cfg, err := LoadConfig(func(key string) string {
		values := map[string]string{
			"CORS_ALLOWED_ORIGINS":   "https://app.nevix.test",
			"ADMIN_EMAIL":            "  Admin@Example.com ",
			"ADMIN_INITIAL_PASSWORD": "initial-password",
		}
		return values[key]
	})
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	// LoadConfig only trims surrounding whitespace; canonicalization and the
	// empty-table decision belong to Bootstrap, which can see the database.
	if cfg.AdminEmail != "Admin@Example.com" {
		t.Fatalf("AdminEmail %q, want the trimmed value", cfg.AdminEmail)
	}
	if cfg.AdminInitialPassword != "initial-password" {
		t.Fatalf("AdminInitialPassword %q, want the verbatim value", cfg.AdminInitialPassword)
	}
}

func TestLoadConfigRejectsWildcardAndMissingTransportVariables(t *testing.T) {
	cases := map[string]map[string]string{
		"missing CORS origins": {"CORS_ALLOWED_ORIGINS": ""},
		"wildcard origin":      {"CORS_ALLOWED_ORIGINS": "*"},
		"wildcard among list":  {"CORS_ALLOWED_ORIGINS": "https://app.nevix.test,*"},
		"empty list entry":     {"CORS_ALLOWED_ORIGINS": "https://app.nevix.test,,"},
	}
	for name, overrides := range cases {
		if _, err := LoadConfig(fullTransportEnv(overrides)); err == nil {
			t.Fatalf("%s: config loaded, want an error", name)
		}
	}
}
