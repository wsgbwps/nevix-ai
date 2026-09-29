package kapon

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func newCatalogClient(t *testing.T, handler http.HandlerFunc) *ModelsCheckClient {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return NewModelsCheckClient(server.URL)
}

func TestCheckAcceptsKeyWithoutInspectingModels(t *testing.T) {
	client := newCatalogClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/models" {
			t.Errorf("check route = %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer valid-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"object":"list","data":[{"id":"unrelated-model"}]}`))
	})
	if err := client.Check(context.Background(), "valid-key"); err != nil {
		t.Fatalf("check: %v", err)
	}
}

func TestCheckIgnoresCatalogBody(t *testing.T) {
	client := newCatalogClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`not json`))
	})
	if err := client.Check(context.Background(), "valid-key"); err != nil {
		t.Fatalf("check: %v", err)
	}
}

func TestCheckMapsProviderVerdicts(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		wantErr error
	}{
		{"token rejected 401", http.StatusUnauthorized, domain.ErrCandidateCredentialInvalid},
		{"token rejected 403", http.StatusForbidden, domain.ErrCandidateCredentialInvalid},
		{"rate limited", http.StatusTooManyRequests, domain.ErrCheckTemporarilyUnavailable},
		{"upstream 503", http.StatusServiceUnavailable, domain.ErrCheckTemporarilyUnavailable},
		{"unexpected 418", http.StatusTeapot, domain.ErrCheckTemporarilyUnavailable},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			client := newCatalogClient(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(testCase.status)
			})
			if err := client.Check(context.Background(), "any"); !errors.Is(err, testCase.wantErr) {
				t.Fatalf("error = %v, want %v", err, testCase.wantErr)
			}
		})
	}
}

func TestCheckTransportFailureIsTransient(t *testing.T) {
	// A server that closes connections mid-request surfaces as a transport
	// error, which must be transient — never a credential verdict.
	client := newCatalogClient(t, func(w http.ResponseWriter, _ *http.Request) {
		panic("connection torn down")
	})
	if err := client.Check(context.Background(), "any"); !errors.Is(err, domain.ErrCheckTemporarilyUnavailable) {
		t.Fatalf("transport error = %v, want transient", err)
	}
}

func TestValidateBaseURLEnforcesRoutePolicy(t *testing.T) {
	for _, raw := range []string{"https://models.kapon.cloud", "https://svip.kapon.cloud", "http://127.0.0.1:9", "http://localhost:1"} {
		if err := ValidateBaseURL(raw); err != nil {
			t.Fatalf("valid route %q rejected: %v", raw, err)
		}
	}
	for _, raw := range []string{
		"https://example.internal", "https://models.kapon.cloud/path", "https://user@models.kapon.cloud",
		"http://models.kapon.cloud", "https://", "ftp://example", "not a url",
	} {
		if err := ValidateBaseURL(raw); err == nil {
			t.Fatalf("invalid route %q accepted", raw)
		}
	}
}
