package integrationtest

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"

	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/event"
	"github.com/nevix-ai/server/internal/release"
)

func TestVersionIsPublicBuildIdentity(t *testing.T) {
	cfg, err := release.LoadConfig(func(string) (string, bool) { return "https://app.nevix.test", true })
	if err != nil {
		t.Fatal(err)
	}
	module, err := release.NewModule(activeAdmin{}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	r.Group(func(r chi.Router) { module.Register(r, event.NewInMemoryBus()) })
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/release/version", nil))
	expectedVersion, expectedMinimum := "development", "0.1.0"
	if os.Getenv("NEVIX_RELEASE_IDENTITY_CHILD") == "1" {
		expectedVersion, expectedMinimum = "1.2.3", "1.1.0"
	}
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"service":"nevix-server"`) || !strings.Contains(w.Body.String(), `"version":"`+expectedVersion+`"`) || !strings.Contains(w.Body.String(), `"min_desktop_version":"`+expectedMinimum+`"`) {
		t.Fatalf("unexpected contract: %d %s", w.Code, w.Body.String())
	}
}

type activeAdmin struct{}

func (activeAdmin) Authenticate(*http.Request) (authz.Principal, error) {
	return authz.Principal{Role: "admin"}, nil
}

func TestModuleWiresReleaseCommands(t *testing.T) {
	cfg, err := release.LoadConfig(func(string) (string, bool) { return "https://app.nevix.test", true })
	if err != nil {
		t.Fatal(err)
	}
	module, err := release.NewModule(activeAdmin{}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Group(func(r chi.Router) { module.Register(r, event.NewInMemoryBus()) })
	for _, command := range []struct{ method, path string }{{"GET", "/release/version"}, {"GET", "/release/status"}, {"POST", "/release/check"}} {
		for _, method := range []string{command.method, "OPTIONS"} {
			req := httptest.NewRequest(method, command.path, nil)
			req.Header.Set("Origin", "https://app.nevix.test")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			want := 200
			if method == "OPTIONS" {
				want = 204
			}
			if response.Code != want || response.Header().Get("Access-Control-Allow-Origin") != "https://app.nevix.test" || response.Header().Get("Access-Control-Allow-Methods") != command.method+", OPTIONS" {
				t.Fatalf("%s %s routing/CORS failed: %d %v", method, command.path, response.Code, response.Header())
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := module.RunWorkers(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestRejectInvalidCompiledIdentity(t *testing.T) {
	if os.Getenv("NEVIX_RELEASE_INVALID_CHILD") == "1" {
		if _, err := release.NewModule(activeAdmin{}, release.Config{}); err == nil {
			t.Fatal("constructor accepted invalid compiled identity")
		}
		if _, err := release.LoadConfig(func(string) (string, bool) { return "https://app.nevix.test", true }); err == nil {
			t.Fatal("config accepted invalid compiled identity")
		}
		return
	}
	for _, identity := range []string{"Version=not-a-release", "MinDesktopVersion=bad"} {
		command := exec.Command("go", "test", ".", "-run", "^TestRejectInvalidCompiledIdentity$", "-ldflags=-X github.com/nevix-ai/server/internal/release."+identity)
		command.Env = append(os.Environ(), "NEVIX_RELEASE_INVALID_CHILD=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("invalid compiled identity accepted: %v %s", err, output)
		}
	}
}

func TestReleaseBuildPublishesCompiledIdentity(t *testing.T) {
	command := exec.Command("go", "test", ".", "-run", "^(TestVersionIsPublicBuildIdentity|TestModuleWiresReleaseCommands)$", "-ldflags=-X github.com/nevix-ai/server/internal/release.Version=1.2.3 -X github.com/nevix-ai/server/internal/release.MinDesktopVersion=1.1.0")
	command.Env = append(os.Environ(), "NEVIX_RELEASE_IDENTITY_CHILD=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("release build endpoint failed: %v %s", err, output)
	}
}

func TestReleaseConfigRequiresExactOrigins(t *testing.T) {
	for _, raw := range []string{"", "*", "https://app.nevix.test,", "https://app.nevix.test,*"} {
		if _, err := release.LoadConfig(func(string) (string, bool) { return raw, raw != "" }); err == nil {
			t.Fatalf("unsafe origins accepted: %q", raw)
		}
	}
}
