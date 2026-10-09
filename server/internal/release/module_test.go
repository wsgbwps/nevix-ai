package release_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/release"
)

type pendingAdmin struct{}

func (pendingAdmin) Authenticate(*http.Request) (authz.Principal, error) {
	return authz.Principal{Role: "admin", MustChangePassword: true}, nil
}

func TestReleaseRequiresCompletedInitialPasswordChange(t *testing.T) {
	router := chi.NewRouter()
	router.Group(func(r chi.Router) { release.NewModule(pendingAdmin{}, nil).Register(r) })
	for _, command := range []struct{ method, path string }{{"GET", "/release/status"}, {"POST", "/release/check"}} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(command.method, command.path, nil))
		if response.Code != 403 {
			t.Fatalf("%s may bypass initial password change: %d", command.path, response.Code)
		}
	}
}
