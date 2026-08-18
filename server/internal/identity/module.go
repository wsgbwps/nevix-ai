// Package identity is the identity Module's composition surface. The command
// skeleton (unified error envelope, decode-validate-map pipeline, and route
// table machinery) lives in command; one-time verification-code issuance lives
// in verification; the Outbox Worker lives in outbox; Bearer JWT verification
// lives in authjwt; and Organization and Invitation command layers live in
// their respective sub-packages. Callers outside the Module — the composition
// root and integration test harness — see only this package: LoadConfig,
// NewModule, Register, and RunWorkers.
package identity

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/event"
	"github.com/nevix-ai/server/internal/identity/authjwt"
	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/invitations"
	"github.com/nevix-ai/server/internal/identity/memberships"
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
	issuer      *verification.CodeIssuer
	invitations *invitations.Creator
	memberships *memberships.Manager
	worker      *outbox.OutboxWorker
	verifier    *authjwt.Verifier
	orgs        *organizations.Manager
	corsOrigins []string
}

// identityAppRole is the only PostgreSQL role the Identity Module may run as:
// the fixed, least-privilege LOGIN role created by the Identity migrations.
const identityAppRole = "identity_app"

// ErrUnexpectedDatabaseIdentity reports that the runtime database
// connection did not prove the expected identity_app execution identity.
// It is wrapped by construction and transaction errors and is never part of
// a public HTTP response; callers use it to distinguish a configuration
// failure from other database errors.
var ErrUnexpectedDatabaseIdentity = errors.New("unexpected database identity")

// NewModule constructs the command layers, the transport guard, and the
// Outbox Worker, after proving the runtime database identity with a real
// round trip: session_user (the authenticated principal) and current_user
// (the role actually used for permission checks) must both be exactly
// identity_app. A pool authenticated as the owner, a migration role, or any
// other role is rejected even when it could SET ROLE identity_app, and an
// unreachable database fails the round trip, so either way construction
// fails before the composition root starts the HTTP listener or workers.
// Worker construction additionally probes the SMTP endpoint, so an
// unreachable endpoint fails startup explicitly.
func NewModule(ctx context.Context, pool *pgxpool.Pool, cfg Config) (*Module, error) {
	if err := verifyRuntimeDatabaseIdentity(ctx, pool); err != nil {
		return nil, err
	}
	worker, err := outbox.NewOutboxWorker(pool, cfg.SMTP, cfg.RetryDelays)
	if err != nil {
		return nil, err
	}
	return &Module{
		issuer:      verification.NewCodeIssuer(pool, cfg.CodeIssuance),
		invitations: invitations.NewCreator(pool, cfg.CodeIssuance),
		memberships: memberships.NewManager(pool, cfg.CodeIssuance.From),
		worker:      worker,
		verifier:    authjwt.NewVerifier(cfg.JWKSURL),
		orgs:        organizations.NewManager(pool),
		corsOrigins: cfg.CORSAllowedOrigins,
	}, nil
}

// verifyRuntimeDatabaseIdentity performs the construction-time round trip:
// it observes the connection's authentication identity (session_user) and
// execution identity (current_user) and requires both to equal
// identity_app. An unreachable or failing database surfaces as a plain
// infrastructure error, distinct from ErrUnexpectedDatabaseIdentity.
func verifyRuntimeDatabaseIdentity(ctx context.Context, pool *pgxpool.Pool) error {
	var sessionUser, currentUser string
	if err := pool.QueryRow(ctx, "SELECT session_user, current_user").Scan(&sessionUser, &currentUser); err != nil {
		return fmt.Errorf("identity: verify runtime database identity: %w", err)
	}
	return unexpectedDatabaseIdentityError(sessionUser, currentUser)
}

// unexpectedDatabaseIdentityError is the identity decision, isolated so the
// two role checks are provable independently of a live database: the
// message records the expected versus observed roles for operators without
// carrying any connection string or credential.
func unexpectedDatabaseIdentityError(sessionUser, currentUser string) error {
	if sessionUser != identityAppRole || currentUser != identityAppRole {
		return fmt.Errorf("%w: runtime database connection must authenticate directly as %s, got session_user=%s current_user=%s",
			ErrUnexpectedDatabaseIdentity, identityAppRole, sessionUser, currentUser)
	}
	return nil
}

// Register mounts the Module's trusted commands from the static route table:
// the CORS whitelist gates the Module surface, every path's OPTIONS preflight
// twin and Allow-Methods value derive from the same table, and routes that do
// not declare Public mount behind the Bearer JWT guard. The Module publishes
// no Domain Events yet; the bus is part of the Module contract.
func (m *Module) Register(r chi.Router, _ event.Bus) {
	routes := m.routes()
	r.Use(corsMiddleware(m.corsOrigins, command.MethodsByPath(routes)))
	command.Mount(r, routes, m.verifier.Middleware)
}

// RunWorkers runs the Module's background workers until ctx is canceled, then
// returns nil. Delivery errors are logged and retried on the backoff
// schedule, not propagated: a failed row already has terminal-state
// bookkeeping in the Outbox.
func (m *Module) RunWorkers(ctx context.Context) error {
	return m.worker.Run(ctx)
}
