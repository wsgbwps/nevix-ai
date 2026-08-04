// Package identity is the identity Module's composition surface. The command
// layer (one-time verification code issuance with synchronous rate limiting)
// lives in the verification sub-package; the Outbox Worker (SMTP deployment
// configuration, the retry backoff schedule, and the pure deliverer that
// polls identity.outbox_messages and sends over standard SMTP) lives in the
// outbox sub-package.
package identity

import (
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/identity/verification"
	"github.com/nevix-ai/server/pkg/event"
)

// Module is the identity Module's composition surface: it owns the command
// layer's dependencies and registers the Module's HTTP routes. The Outbox
// Worker is wired separately in the composition root — it is a background
// goroutine, not an HTTP handler.
type Module struct {
	issuer *verification.CodeIssuer
}

func NewModule(pool *pgxpool.Pool, cfg verification.CodeIssuanceConfig) *Module {
	return &Module{issuer: verification.NewCodeIssuer(pool, cfg)}
}

// Register mounts the identity Module's external commands. The Module
// publishes no Domain Events yet; the bus is part of the Module contract.
func (m *Module) Register(r chi.Router, _ event.Bus) {
	r.Post("/identity/verification-codes", m.issuer.ServeHTTP)
}
