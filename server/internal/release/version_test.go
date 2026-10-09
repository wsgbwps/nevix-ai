package release_test

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/nevix-ai/server/internal/release"
)

func TestVersionIsPublicBuildIdentity(t *testing.T) {
	r := chi.NewRouter()
	release.RegisterVersion(r)
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

func TestRejectInvalidCompiledIdentity(t *testing.T) {
	oldVersion, oldMinimum := release.Version, release.MinDesktopVersion
	defer func() { release.Version, release.MinDesktopVersion = oldVersion, oldMinimum }()
	release.Version = "not-a-release"
	if release.ValidateBuildIdentity() == nil {
		t.Fatal("invalid running version accepted")
	}
	release.Version = "1.0.1"
	release.MinDesktopVersion = "bad"
	if release.ValidateBuildIdentity() == nil {
		t.Fatal("invalid minimum accepted")
	}
}

func TestReleaseBuildPublishesCompiledIdentity(t *testing.T) {
	command := exec.Command("go", "test", ".", "-run", "^TestVersionIsPublicBuildIdentity$", "-ldflags=-X github.com/nevix-ai/server/internal/release.Version=1.2.3 -X github.com/nevix-ai/server/internal/release.MinDesktopVersion=1.1.0")
	command.Env = append(os.Environ(), "NEVIX_RELEASE_IDENTITY_CHILD=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("release build endpoint failed: %v %s", err, output)
	}
}
