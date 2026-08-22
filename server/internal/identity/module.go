// Package identity is the identity Module's composition surface. The command
// skeleton (unified error envelope, decode-validate-map pipeline, guard-policy
// route table machinery) lives in command; the auth service (passwords,
// sessions, login/logout/me, bootstrap, the maintenance sweep) lives in auth;
// the user-account surface beyond self (team directory, admin governance
// commands) lives in users; audit log writes and the admin-only paginated
// read live in audit; and the Write Transaction Module lives in writetx.
// Callers outside the Module — the composition root and the integration test
// harness — see only this package: LoadConfig, NewModule, Register, and
// RunWorkers.
package identity

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/event"
	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/auth"
	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/users"
	"github.com/nevix-ai/server/internal/identity/writetx"
)

// Config is the identity Module's deployment configuration. AdminEmail and
// AdminInitialPassword bootstrap the first admin on an empty database and are
// inert once any user exists (ADR-0015); CORSAllowedOrigins is the
// per-environment browser origin whitelist.
type Config struct {
	AdminEmail           string
	AdminInitialPassword string
	CORSAllowedOrigins   []string
}

// LoadConfig reads the Module's deployment variables via getenv. A missing or
// invalid variable is an error naming that variable; the composition root
// loads configuration before opening the database pool, so a misconfigured
// process fails before touching infrastructure. Bootstrap credentials are
// optional at load time: whether they matter depends on the database being
// empty, which only NewModule can observe.
func LoadConfig(getenv func(string) string) (Config, error) {
	corsOrigins, err := loadCORSAllowedOrigins(getenv("CORS_ALLOWED_ORIGINS"))
	if err != nil {
		return Config{}, err
	}
	return Config{
		AdminEmail:           strings.TrimSpace(getenv("ADMIN_EMAIL")),
		AdminInitialPassword: getenv("ADMIN_INITIAL_PASSWORD"),
		CORSAllowedOrigins:   corsOrigins,
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

// Module is the identity Module's composition surface: it owns the auth
// service, the user-account governance service, the audit read service, the
// guard vocabulary, and registers the Module's HTTP routes.
type Module struct {
	auth        *auth.Service
	users       *users.Service
	auditRead   *audit.ReadService
	guard       *authz.Guard
	corsOrigins []string
}

// ErrUnexpectedDatabaseIdentity reports that the runtime database
// connection did not prove the expected identity_app execution identity.
// The sentinel lives in the Write Transaction Module, which wraps it from
// both Module construction and every write transaction; it is never part of
// a public HTTP response. Callers use it to distinguish a configuration
// failure from other database errors.
var ErrUnexpectedDatabaseIdentity = writetx.ErrUnexpectedDatabaseIdentity

// NewModule constructs the auth service and the guard vocabulary around one
// Write Transaction Module (writetx.Runner): after proving the runtime
// database identity with a real round trip — session_user (the authenticated
// principal) and current_user (the role actually used for permission checks)
// must both be exactly identity_app — every user, session, and audit write
// transaction runs through the same runner, which re-proves the identity per
// transaction and owns commit and rollback. A pool authenticated as the
// owner, a migration role, or any other role is rejected even when it could
// SET ROLE identity_app, and an unreachable database fails the round trip, so
// either way construction fails before the composition root starts the HTTP
// listener or workers. Construction then runs the first-admin bootstrap: on
// an empty users table the ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD pair creates
// the first admin; on a non-empty table the pair is ignored with a warning.
func NewModule(ctx context.Context, pool *pgxpool.Pool, cfg Config) (*Module, error) {
	tx := writetx.New(pool)
	if err := tx.VerifyStartupIdentity(ctx); err != nil {
		return nil, err
	}
	service := auth.NewService(pool, tx)
	if err := service.Bootstrap(ctx, cfg.AdminEmail, cfg.AdminInitialPassword); err != nil {
		return nil, err
	}
	return &Module{
		auth:        service,
		users:       users.NewService(pool, tx),
		auditRead:   audit.NewReadService(pool),
		guard:       authz.NewGuard(service),
		corsOrigins: cfg.CORSAllowedOrigins,
	}, nil
}

// Register mounts the Module's trusted commands from the static route table:
// the CORS whitelist gates the Module surface, every path's OPTIONS preflight
// twin and Allow-Methods value derive from the same table, and every route
// runs behind its declared authz guard (only login is public). The Module
// publishes no Domain Events yet; the bus is part of the Module contract.
func (m *Module) Register(r chi.Router, _ event.Bus) {
	routes := m.routes()
	r.Use(corsMiddleware(m.corsOrigins, command.MethodsByPath(routes)))
	command.Mount(r, routes, command.Guards{
		ActiveUser: m.guard.RequireActiveUser,
		Admin:      m.guard.RequireAdmin,
	})
}

// RunWorkers runs the Module's background maintenance until ctx is canceled,
// then returns nil: the daily sweep deletes expired sessions, prunes the
// login limiter, and re-logs the pending-initial-password reminder. Sweep
// failures are logged and retried on the next tick, not propagated.
func (m *Module) RunWorkers(ctx context.Context) error {
	return m.auth.RunSweepLoop(ctx)
}
