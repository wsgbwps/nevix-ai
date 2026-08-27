// Package identity exposes the Identity Module's composition contract.
// External callers use only LoadConfig, NewModule, Register, and RunWorkers;
// its responsibility packages remain internal.
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
	"github.com/nevix-ai/server/internal/identity/joincodes"
	"github.com/nevix-ai/server/internal/identity/reauth"
	"github.com/nevix-ai/server/internal/identity/session"
	"github.com/nevix-ai/server/internal/identity/users"
	"github.com/nevix-ai/server/internal/identity/writetx"
)

// Config is the Identity Module's deployment configuration.
// SetupCodeRequired enables optional Instance Claim protection, and
// CORSAllowedOrigins is the browser origin whitelist.
type Config struct {
	SetupCodeRequired  bool
	CORSAllowedOrigins []string
}

// LoadConfig validates the Module's deployment variables. It rejects legacy
// admin-bootstrap variables even when empty, preventing an old deployment
// configuration from silently changing Instance Claim protection.
func LoadConfig(lookup func(string) (string, bool)) (Config, error) {
	corsOrigins, err := loadCORSAllowedOrigins(lookupValue(lookup, "CORS_ALLOWED_ORIGINS"))
	if err != nil {
		return Config{}, err
	}
	for _, legacy := range []string{"ADMIN_EMAIL", "ADMIN_INITIAL_PASSWORD"} {
		if _, present := lookup(legacy); present {
			return Config{}, fmt.Errorf("identity: %s is no longer supported; the first admin is created through the Instance Claim wizard — remove it and use NEVIX_SETUP_CODE_REQUIRED for optional claim protection", legacy)
		}
	}
	setupCodeRequired, err := loadSetupCodeRequired(lookupValue(lookup, "NEVIX_SETUP_CODE_REQUIRED"))
	if err != nil {
		return Config{}, err
	}
	return Config{
		SetupCodeRequired:  setupCodeRequired,
		CORSAllowedOrigins: corsOrigins,
	}, nil
}

// lookupValue reads one variable through the presence-aware lookup,
// collapsing unset and set-to-empty; callers that must distinguish the two
// read the lookup directly.
func lookupValue(lookup func(string) (string, bool), key string) string {
	v, _ := lookup(key)
	return v
}

// loadSetupCodeRequired parses the Instance Claim protection flag strictly:
// unset or empty claims open (no credential), "true" requires the one-time
// setup code, "false" claims open explicitly, and every other value — TRUE,
// 1, yes, even padded spellings — is a configuration error, not a guess.
func loadSetupCodeRequired(raw string) (bool, error) {
	switch raw {
	case "":
		return false, nil
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("identity: NEVIX_SETUP_CODE_REQUIRED must be true or false, got %q", raw)
	}
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

// Module is the Identity Module's composition surface.
type Module struct {
	auth        *auth.Service
	users       *users.Service
	joinCodes   *joincodes.Service
	reauth      *reauth.Service
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

// SessionAuthenticator exposes the narrow seam other Modules consume through
// the composition root (ADR-0016 认证注入): proof of the calling principal
// without any credential-verification knowledge leaving Identity.
func (m *Module) SessionAuthenticator() authz.SessionAuthenticator { return m.auth }

// ReauthProofs exposes the narrow exact-action proof consumption seam other
// Modules consume through the composition root (ADR-0016 认证注入): one
// single-use, no-restore consumption inside Identity's own committed write
// transaction with its audit row. The caller checks proven HTTPS transport
// before invoking it, so consumption only ever happens for a transport that
// could carry the high-risk command.
func (m *Module) ReauthProofs() authz.ReauthProofVerifier {
	return reauthVerifier{service: m.reauth}
}

// reauthVerifier adapts the reauth service to the shared authz vocabulary,
// translating its sentinels so consuming Modules never import Identity.
type reauthVerifier struct {
	service *reauth.Service
}

// VerifyProof consumes one exact-action proof for the calling principal.
// Failures are fail-closed and leave the proof row exactly as it was.
func (v reauthVerifier) VerifyProof(ctx context.Context, principal authz.Principal, action, proof string) error {
	_, err := v.service.Consume(ctx, principal, reauth.ConsumeRequest{Proof: &proof, Action: &action})
	if err != nil {
		switch {
		case errors.Is(err, reauth.ErrProofInvalid):
			return authz.ErrProofInvalid
		case errors.Is(err, reauth.ErrProofExpired):
			return authz.ErrProofExpired
		case errors.Is(err, reauth.ErrProofActionMismatch):
			return authz.ErrProofActionMismatch
		case errors.Is(err, reauth.ErrProofAlreadyConsumed):
			return authz.ErrProofAlreadyConsumed
		case errors.Is(err, reauth.ErrInsecureTransport):
			return authz.ErrProofInsecureTransport
		default:
			return fmt.Errorf("identity: consume reauth proof: %w", err)
		}
	}
	return nil
}

// NewModule constructs Identity around one Write Transaction Module. A real
// database round trip must prove both session_user and current_user are
// identity_app; owner, migration, SET ROLE-capable, and unreachable
// connections all fail construction. Every Identity write shares the runner,
// which repeats the execution-identity check and owns transaction completion.
func NewModule(ctx context.Context, pool *pgxpool.Pool, cfg Config) (*Module, error) {
	tx := writetx.New(pool)
	if err := tx.VerifyStartupIdentity(ctx); err != nil {
		return nil, err
	}
	sessions := session.NewService(pool, tx)
	service := auth.NewService(pool, tx, sessions)
	if err := service.ArmInstanceClaim(ctx, cfg.SetupCodeRequired); err != nil {
		return nil, err
	}
	return &Module{
		auth:        service,
		users:       users.NewService(pool, tx, sessions),
		joinCodes:   joincodes.NewService(pool, tx),
		reauth:      reauth.NewService(tx, service),
		auditRead:   audit.NewReadService(pool),
		guard:       authz.NewGuard(service),
		corsOrigins: cfg.CORSAllowedOrigins,
	}, nil
}

// Register mounts the static route table behind its CORS and authorization
// declarations. The Module publishes no Domain Events yet; the bus remains
// part of the Module contract.
func (m *Module) Register(r chi.Router, _ event.Bus) {
	routes := m.routes()
	r.Use(corsMiddleware(m.corsOrigins, command.MethodsByPath(routes)))
	command.Mount(r, routes, command.Guards{
		ActiveUser: m.guard.RequireActiveUser,
		Admin:      m.guard.RequireAdmin,
	})
}

// RunWorkers runs the Module's background maintenance until ctx is canceled,
// then returns nil: the daily sweeps delete expired sessions, prune the
// login limiter, re-log the pending-initial-password reminder, and reclaim
// expired reauth proofs. Sweep failures are logged and retried on the next
// tick, not propagated.
func (m *Module) RunWorkers(ctx context.Context) error {
	done := make(chan error, 2)
	go func() { done <- m.auth.RunSweepLoop(ctx) }()
	go func() { done <- m.reauth.RunSweepLoop(ctx) }()
	var firstErr error
	for i := 0; i < 2; i++ {
		if err := <-done; err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
