// Shared transport wiring for the HTTP command tests: mounts the Module
// exactly as the composition root mounts it (a chi Group, where group-scoped
// middleware runs only on matched routes), so tests assert only the HTTP
// contract and derived preflight twins behave as in production.
package integrationtest

import (
	"context"
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/nevix-ai/server/internal/event"
	"github.com/nevix-ai/server/internal/identity"
)

// newTransportHandler mounts the Module with the transport configuration
// pointed at the test key set and whitelist.
func newTransportHandler(t *testing.T, h *harness, jwksURL string, origins []string) http.Handler {
	t.Helper()
	cfg := h.cfg
	cfg.JWKSURL = jwksURL
	cfg.CORSAllowedOrigins = origins
	m, err := identity.NewModule(context.Background(), h.runtimePool, cfg)
	if err != nil {
		t.Fatalf("construct identity module: %v", err)
	}
	router := chi.NewRouter()
	router.Group(func(r chi.Router) { m.Register(r, event.NewInMemoryBus()) })
	return router
}

// commandRouter mounts the Module's external commands through a chi Group
// exactly as the composition root does, so tests assert only the HTTP
// contract (group-scoped middleware runs only on matched routes, so the
// derived preflight twins behave as in production).
func (h *harness) commandRouter(t *testing.T) http.Handler {
	t.Helper()
	m, err := identity.NewModule(context.Background(), h.runtimePool, h.cfg)
	if err != nil {
		t.Fatalf("construct identity module: %v", err)
	}
	router := chi.NewRouter()
	router.Group(func(r chi.Router) { m.Register(r, event.NewInMemoryBus()) })
	return router
}
