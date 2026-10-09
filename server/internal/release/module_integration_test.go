package release

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nevix-ai/server/internal/event"
	"github.com/nevix-ai/server/internal/identity"
	"golang.org/x/crypto/bcrypt"
)

type publisherTransport struct {
	target    *url.URL
	transport http.RoundTripper
}

func (p publisherTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.String() != officialManifestURL || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
		return nil, fmt.Errorf("unexpected publisher request %s", r.URL)
	}
	copy := r.Clone(r.Context())
	copy.URL.Scheme, copy.URL.Host = p.target.Scheme, p.target.Host
	copy.Host = p.target.Host
	return p.transport.RoundTrip(copy)
}

// The production Module has no key/source override. Only this isolated publisher
// fixture replaces its HTTPS transport and compiled trust input for acceptance.
func TestReleaseSignedSourceWithRealIdentity(t *testing.T) {
	ownerURL, runtimeURL := os.Getenv("NEVIX_DATABASE_URL"), os.Getenv("NEVIX_IDENTITY_DATABASE_URL")
	if ownerURL == "" || runtimeURL == "" {
		if os.Getenv("NEVIX_IDENTITY_INTEGRATION_REQUESTED") == "1" {
			t.Fatal("requested Release integration lacks the Identity harness DSNs")
		}
		t.Skip("run make test-identity-integration for real Identity acceptance")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	if _, err := owner.Exec(ctx, `TRUNCATE public.users CASCADE`); err != nil {
		t.Fatal(err)
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte("release-password-1"), bcrypt.MinCost)
	if _, err := owner.Exec(ctx, `INSERT INTO public.users (email,password_hash,display_name,role,status,must_change_password) VALUES ($1,$2,'Release Admin','admin','active',false)`, "admin@release-source.test", string(hash)); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	identityModule, err := identity.NewModule(ctx, pool, identity.Config{CORSAllowedOrigins: []string{"https://app.nevix.test"}})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Group(func(r chi.Router) { identityModule.Register(r, event.NewInMemoryBus()) })
	login := httptest.NewRecorder()
	router.ServeHTTP(login, httptest.NewRequest("POST", "/identity/auth/login", strings.NewReader(`{"email":"admin@release-source.test","password":"release-password-1","device_name":"release-test"}`)))
	var session struct {
		Token string `json:"token"`
	}
	if login.Code != 200 || json.Unmarshal(login.Body.Bytes(), &session) != nil || session.Token == "" {
		t.Fatalf("real Identity login: %d %s", login.Code, login.Body.String())
	}

	public, private, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(public)
	manifest := Manifest{Version: "2.1.0", Channel: "stable", Platform: "linux", Arch: "amd64", MinServerVersion: "2.0.0", MinDesktopVersion: "1.5.0", URL: "https://example.test/nevix.tar.gz", Size: 42, SHA512: base64.StdEncoding.EncodeToString(make([]byte, 64))}
	envelope := func(value Manifest) []byte {
		payload, _ := json.Marshal(value)
		body, _ := json.Marshal(struct {
			Format    string `json:"format"`
			Payload   string `json:"payload"`
			Signature string `json:"signature"`
		}{"nevix-release-v1", base64.StdEncoding.EncodeToString(payload), base64.StdEncoding.EncodeToString(ed25519.Sign(private, payload))})
		return body
	}
	var mu sync.Mutex
	responseStatus, responseBody := 200, envelope(manifest)
	publisher := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.URL.RawQuery != "" {
			t.Error("customer credentials sent to publisher")
		}
		mu.Lock()
		defer mu.Unlock()
		if responseStatus == 302 {
			w.Header().Set("Location", "https://example.test/not-official")
		}
		w.WriteHeader(responseStatus)
		_, _ = w.Write(responseBody)
	}))
	defer publisher.Close()
	target, _ := url.Parse(publisher.URL)
	module := NewModule(identityModule.SessionAuthenticator(), []string{"https://app.nevix.test"})
	module.publicKey = string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	module.status.Version, module.status.MinDesktopVersion = "2.0.0", "1.0.0"
	module.client.Transport = publisherTransport{target, publisher.Client().Transport}
	router.Group(func(r chi.Router) { module.Register(r) })
	request := func(method, path string) releaseStatus {
		t.Helper()
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("Authorization", "Bearer "+session.Token)
		req.Header.Set("Origin", "https://app.nevix.test")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		var status releaseStatus
		if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &status) != nil {
			t.Fatalf("%s %s: %d %s", method, path, rec.Code, rec.Body.String())
		}
		if rec.Header().Get("Access-Control-Allow-Origin") != "https://app.nevix.test" {
			t.Fatal("missing scoped CORS")
		}
		return status
	}
	if got := request("POST", "/release/check"); got.Outcome != "available" || got.Version != "2.0.0" || got.MinDesktopVersion != "1.0.0" || got.CheckedAt == nil || got.Candidate == nil || !got.Candidate.Compatible || got.Candidate.Version != "2.1.0" || got.Candidate.MinDesktopVersion != "1.5.0" {
		t.Fatalf("signed candidate: %+v", got)
	}
	incompatible := manifest
	incompatible.MinServerVersion = "3.0.0"
	old := manifest
	old.Version = "1.9.0"
	wrongArch := manifest
	wrongArch.Arch = "arm64"
	for _, scenario := range []struct {
		name    string
		status  int
		body    []byte
		outcome string
	}{
		{"incompatible source", 200, envelope(incompatible), "incompatible"},
		{"older release", 200, envelope(old), "current"},
		{"wrong architecture", 200, envelope(wrongArch), "invalid-release"},
		{"bad signature", 200, bytes.Replace(envelope(manifest), []byte(`"signature":"`), []byte(`"signature":"A`), 1), "invalid-release"},
		{"malformed", 200, []byte(`{}`), "invalid-release"},
		{"oversized", 200, bytes.Repeat([]byte(" "), 64*1024+1), "network-failure"},
		{"unavailable source", 502, nil, "network-failure"},
		{"manifest redirect", 302, nil, "network-failure"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			mu.Lock()
			responseStatus, responseBody = scenario.status, scenario.body
			mu.Unlock()
			got := request("POST", "/release/check")
			if got.Outcome != scenario.outcome {
				t.Fatalf("check outcome %s, want %s", got.Outcome, scenario.outcome)
			}
			if scenario.outcome != "incompatible" && got.Candidate != nil {
				t.Fatal("failed/old check retained a trusted candidate")
			}
			if scenario.outcome == "incompatible" && (got.Candidate == nil || got.Candidate.Compatible) {
				t.Fatal("source incompatibility not shown")
			}
			if visible := request("GET", "/release/status"); visible.Outcome != got.Outcome {
				t.Fatal("manual result not visible in status")
			}
			health := httptest.NewRecorder()
			router.ServeHTTP(health, httptest.NewRequest("GET", "/identity/setup/status", nil))
			if health.Code != 200 {
				t.Fatal("publisher failure affected Identity business")
			}
		})
	}
	mu.Lock()
	responseStatus, responseBody = 200, envelope(manifest)
	mu.Unlock()
	workerCtx, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- module.RunWorkers(workerCtx) }()
	deadline := time.Now().Add(3 * time.Second)
	for request("GET", "/release/status").Outcome != "available" {
		if time.Now().After(deadline) {
			t.Fatal("startup worker did not check")
		}
		time.Sleep(10 * time.Millisecond)
	}
	stop()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not stop")
	}
	publisher.Close()
	got := request("POST", "/release/check")
	if got.Outcome != "network-failure" || got.Candidate != nil {
		t.Fatal("transport failure retained candidate")
	}
}
