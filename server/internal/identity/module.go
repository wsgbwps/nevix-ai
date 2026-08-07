// Package identity is the identity Module's composition surface. The command
// layer (one-time verification code issuance with synchronous rate limiting)
// lives in the verification sub-package; the Outbox Worker (SMTP deployment
// configuration, the retry backoff schedule, and the pure deliverer that
// polls identity.outbox_messages and sends over standard SMTP) lives in the
// outbox sub-package; the Bearer JWT transport guard (JWKS verification) lives
// in the authjwt sub-package and the organization command layer in the
// organizations sub-package. Callers outside the Module — the composition
// root and the integration test harness — see only this package: LoadConfig,
// NewModule, Register, and RunWorkers.
package identity

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/event"
	"github.com/nevix-ai/server/internal/identity/authjwt"
	"github.com/nevix-ai/server/internal/identity/organizations"
	"github.com/nevix-ai/server/internal/identity/outbox"
	"github.com/nevix-ai/server/internal/identity/verification"
)

// Config is the identity Module's deployment configuration, aggregated from
// the sub-package loaders so the composition root sees one seam. JWKSURL is
// the auth provider's published key set for Bearer JWT verification;
// CORSAllowedOrigins is the per-environment browser origin whitelist.
type Config struct {
	CodeIssuance       verification.CodeIssuanceConfig
	SMTP               outbox.SMTPConfig
	RetryDelays        []time.Duration
	JWKSURL            string
	CORSAllowedOrigins []string
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
	jwksURL := getenv("AUTH_JWKS_URL")
	if jwksURL == "" {
		return Config{}, errors.New("identity: missing required deployment variable: AUTH_JWKS_URL")
	}
	corsOrigins, err := loadCORSAllowedOrigins(getenv("CORS_ALLOWED_ORIGINS"))
	if err != nil {
		return Config{}, err
	}
	return Config{
		CodeIssuance:       codeIssuance,
		SMTP:               smtp,
		RetryDelays:        retryDelays,
		JWKSURL:            jwksURL,
		CORSAllowedOrigins: corsOrigins,
	}, nil
}

// loadCORSAllowedOrigins parses the comma-separated whitelist. It must name
// at least one exact origin: the empty list would lock out every browser
// client, and a wildcard is never accepted.
func loadCORSAllowedOrigins(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, errors.New("identity: missing required deployment variable: CORS_ALLOWED_ORIGINS")
	}
	origins := []string{}
	for _, entry := range strings.Split(raw, ",") {
		origin := strings.TrimSpace(entry)
		if origin == "*" {
			return nil, errors.New("identity: CORS_ALLOWED_ORIGINS must never contain a wildcard")
		}
		if origin == "" {
			return nil, fmt.Errorf("identity: CORS_ALLOWED_ORIGINS contains an empty entry: %q", raw)
		}
		origins = append(origins, origin)
	}
	return origins, nil
}

// Module is the identity Module's composition surface: it owns the command
// layers', the transport guard's, and the Outbox Worker's dependencies and
// registers the Module's HTTP routes.
type Module struct {
	issuer   *verification.CodeIssuer
	worker   *outbox.OutboxWorker
	verifier *authjwt.Verifier
	orgs     *organizations.Creator
	cors     func(http.Handler) http.Handler
}

// NewModule constructs the command layers, the transport guard, and the
// Outbox Worker. Worker construction probes the SMTP endpoint, so an
// unreachable endpoint fails startup explicitly.
func NewModule(pool *pgxpool.Pool, cfg Config) (*Module, error) {
	worker, err := outbox.NewOutboxWorker(pool, cfg.SMTP, cfg.RetryDelays)
	if err != nil {
		return nil, err
	}
	return &Module{
		issuer:   verification.NewCodeIssuer(pool, cfg.CodeIssuance),
		worker:   worker,
		verifier: authjwt.NewVerifier(cfg.JWKSURL),
		orgs:     organizations.NewCreator(pool),
		cors:     corsMiddleware(cfg.CORSAllowedOrigins),
	}, nil
}

// Register mounts the identity Module's external commands behind the CORS
// whitelist; Bearer JWT commands additionally pass the transport guard. The
// explicit OPTIONS routes keep browser preflights reachable when the Module
// is mounted inside a chi Group, where route-scoped middleware never runs
// for unmatched methods. The Module publishes no Domain Events yet; the bus
// is part of the Module contract.
func (m *Module) Register(r chi.Router, _ event.Bus) {
	r.Use(m.cors)
	r.Options("/identity/verification-codes", preflightEndpoint)
	r.Options("/identity/organizations", preflightEndpoint)
	r.Post("/identity/verification-codes", m.issuer.ServeHTTP)
	r.With(m.verifier.Middleware).Post("/identity/organizations", m.orgs.ServeHTTP)
}

// RunWorkers runs the Module's background workers until ctx is canceled, then
// returns nil. Delivery errors are logged and retried on the backoff
// schedule, not propagated: a failed row already has terminal-state
// bookkeeping in the Outbox.
func (m *Module) RunWorkers(ctx context.Context) error {
	return m.worker.Run(ctx)
}
