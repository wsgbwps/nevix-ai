// Package identity is the identity Module's composition surface. The command
// layer (one-time verification code issuance with synchronous rate limiting)
// lives in the verification sub-package; the Outbox Worker (SMTP deployment
// configuration, the retry backoff schedule, and the pure deliverer that
// polls identity.outbox_messages and sends over standard SMTP) lives in the
// outbox sub-package. Callers outside the Module — the composition root and
// the integration test harness — see only this package: LoadConfig, NewModule,
// Register, and RunWorkers.
package identity

import (
	"context"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/event"
	"github.com/nevix-ai/server/internal/identity/outbox"
	"github.com/nevix-ai/server/internal/identity/verification"
)

// Config is the identity Module's deployment configuration, aggregated from
// the sub-package loaders so the composition root sees one seam.
type Config struct {
	CodeIssuance verification.CodeIssuanceConfig
	SMTP         outbox.SMTPConfig
	RetryDelays  []time.Duration
}

// LoadConfig reads the Module's deployment variables via getenv, delegating
// to the sub-package loaders. A missing or invalid variable is an error
// naming that variable; the composition root loads configuration before
// opening the database pool, so a misconfigured process fails before touching
// infrastructure.
func LoadConfig(getenv func(string) string) (Config, error) {
	codeIssuance, err := verification.LoadCodeIssuanceConfig(getenv)
	if err != nil {
		return Config{}, err
	}
	smtp, err := outbox.LoadSMTPConfig(getenv)
	if err != nil {
		return Config{}, err
	}
	retryDelays, err := outbox.LoadRetryDelays(getenv)
	if err != nil {
		return Config{}, err
	}
	return Config{CodeIssuance: codeIssuance, SMTP: smtp, RetryDelays: retryDelays}, nil
}

// Module is the identity Module's composition surface: it owns the command
// layer's and the Outbox Worker's dependencies and registers the Module's
// HTTP routes.
type Module struct {
	issuer *verification.CodeIssuer
	worker *outbox.OutboxWorker
}

// NewModule constructs the command layer and the Outbox Worker. Worker
// construction probes the SMTP endpoint, so an unreachable endpoint fails
// startup explicitly.
func NewModule(pool *pgxpool.Pool, cfg Config) (*Module, error) {
	worker, err := outbox.NewOutboxWorker(pool, cfg.SMTP, cfg.RetryDelays)
	if err != nil {
		return nil, err
	}
	return &Module{
		issuer: verification.NewCodeIssuer(pool, cfg.CodeIssuance),
		worker: worker,
	}, nil
}

// Register mounts the identity Module's external commands. The Module
// publishes no Domain Events yet; the bus is part of the Module contract.
func (m *Module) Register(r chi.Router, _ event.Bus) {
	r.Post("/identity/verification-codes", m.issuer.ServeHTTP)
}

// RunWorkers runs the Module's background workers until ctx is canceled, then
// returns nil. Delivery errors are logged and retried on the backoff
// schedule, not propagated: a failed row already has terminal-state
// bookkeeping in the Outbox.
func (m *Module) RunWorkers(ctx context.Context) error {
	return m.worker.Run(ctx)
}
