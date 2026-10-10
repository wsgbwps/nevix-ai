package integrationtest

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/nevix-ai/server/internal/event"
	"github.com/nevix-ai/server/internal/release"
)

func TestReleaseChecksRequireRealActiveAdmin(t *testing.T) {
	h := newHarness(t, context.Background())
	h.resetUserState(t)
	h.insertUser(t, "admin@release.test", "admin-password-1", "admin", "active", false)
	h.insertUser(t, "member@release.test", "member-password-1", "member", "active", false)
	h.insertUser(t, "pending@release.test", "pending-password-1", "admin", "active", true)
	m, identityRouter := h.moduleWithConfig(t, h.cfg)
	_, _, admin := doLogin(t, identityRouter, "admin@release.test", "admin-password-1")
	_, _, member := doLogin(t, identityRouter, "member@release.test", "member-password-1")
	_, _, pending := doLogin(t, identityRouter, "pending@release.test", "pending-password-1")
	router := chi.NewRouter()
	releaseModule, err := release.NewModule(m.SessionAuthenticator(), release.Config{CORSAllowedOrigins: h.cfg.CORSAllowedOrigins})
	if err != nil {
		t.Fatal(err)
	}
	router.Group(func(r chi.Router) { releaseModule.Register(r, event.NewInMemoryBus()) })
	for _, command := range []struct{ method, path string }{{"GET", "/release/status"}, {"POST", "/release/check"}} {
		for _, caller := range []struct {
			token  string
			status int
		}{{"", 401}, {"invalid", 401}, {member.Token, 403}, {pending.Token, 403}, {admin.Token, 200}} {
			status, body := doAuthenticated(t, router, command.method, command.path, caller.token)
			assertContractResponse(t, command.method, command.path, status, body)
			if status != caller.status {
				t.Fatalf("%s %s: status %d, want %d: %s", command.method, command.path, status, caller.status, body)
			}
			if release.PublicKeyPEM == "" && caller.token == admin.Token && command.method == "POST" && !strings.Contains(string(body), `"outcome":"trust-unconfigured"`) {
				t.Fatalf("missing visible unconfigured result: %s", body)
			}
		}
	}
	status, _ := doLogout(t, identityRouter, admin.Token)
	if status != http.StatusOK {
		t.Fatalf("logout: %d", status)
	}
	status, _ = doAuthenticated(t, router, "POST", "/release/check", admin.Token)
	if status != 401 {
		t.Fatalf("revoked Admin may check: %d", status)
	}
}
