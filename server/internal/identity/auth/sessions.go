// The authentication adapter and the auth-owned session surfaces that remain
// after the Session responsibility module cutover: bearer parsing in front of
// session validation, the retention sweep, and the user loads the auth
// commands read. Token mechanics, issuance, validation, sliding refresh, and
// revocation live in the identity Module's session package (spec #138); all
// writes run through the Write Transaction Module (ADR-0015).
package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/identity/session"
	"github.com/nevix-ai/server/internal/identity/writetx"
)

const (
	// auditRetention is the rolling audit-log window: rows older than this
	// are deleted by the daily sweep. Audit is operational history, not a
	// compliance archive (ADR-0009).
	auditRetention = 365 * 24 * time.Hour
)

// userRecord mirrors the users columns the auth commands read.
type userRecord struct {
	ID                 string
	Email              string
	PasswordHash       string
	DisplayName        string
	Role               string
	Status             string
	MustChangePassword bool
}

// bearerToken extracts the opaque token from an Authorization header. The
// scheme match is case-insensitive (RFC 9110); a missing or malformed header
// yields false, and the token never travels in a URL or query (ADR-0014).
func bearerToken(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	scheme, credentials, found := strings.Cut(header, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") || strings.TrimSpace(credentials) == "" || strings.ContainsAny(credentials, " \t") {
		return "", false
	}
	return credentials, true
}

// Authenticate resolves a request's bearer token to an active-user Principal
// (authz.SessionAuthenticator). Bearer parsing stays here; validation is the
// session module's one owned step. Unknown, expired, or revoked sessions and
// disabled accounts all answer authz.ErrNotAuthenticated; any other error is
// infrastructure noise the guard answers with 500.
func (s *Service) Authenticate(r *http.Request) (authz.Principal, error) {
	token, ok := bearerToken(r)
	if !ok {
		return authz.Principal{}, authz.ErrNotAuthenticated
	}
	validated, err := s.sessions.Validate(r.Context(), token)
	if errors.Is(err, session.ErrInvalid) {
		return authz.Principal{}, authz.ErrNotAuthenticated
	}
	if err != nil {
		return authz.Principal{}, fmt.Errorf("auth: validate session: %w", err)
	}
	return authz.Principal{
		SessionID:          validated.SessionID,
		UserID:             validated.UserID,
		Email:              validated.Email,
		DisplayName:        validated.DisplayName,
		Role:               validated.Role,
		MustChangePassword: validated.MustChangePassword,
	}, nil
}

// sweepOnce deletes expired sessions, sweeps audit rows past the 365-day
// retention window (ADR-0009), and prunes the login limiter — the daily
// maintenance owned by the module's worker loop.
func (s *Service) sweepOnce(ctx context.Context) {
	err := s.runner.Run(ctx, func(sc *writetx.Scope) error {
		tx := sc.Tx()
		if _, err := tx.Exec(ctx, `DELETE FROM public.sessions WHERE expires_at < now()`); err != nil {
			return fmt.Errorf("auth: sweep expired sessions: %w", err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM public.audit_logs WHERE created_at < now() - make_interval(secs => $1)`, auditRetention.Seconds()); err != nil {
			return fmt.Errorf("auth: sweep expired audit rows: %w", err)
		}
		return nil
	})
	if err != nil {
		slog.Error("identity: retention sweep failed", "error", err)
	}
	s.warnPendingInitialPasswords(ctx)
	s.limiter.Prune(time.Now())
}

// loadUserByEmail reads one user by canonical email.
func (s *Service) loadUserByEmail(ctx context.Context, email string) (userRecord, error) {
	var user userRecord
	err := s.db.QueryRow(ctx,
		`SELECT id, email, password_hash, display_name, role, status, must_change_password
		 FROM public.users WHERE email = $1`, email,
	).Scan(&user.ID, &user.Email, &user.PasswordHash, &user.DisplayName, &user.Role, &user.Status, &user.MustChangePassword)
	if err != nil {
		return userRecord{}, err
	}
	return user, nil
}

// loadUserByID reads one user by id (the /users/me read).
func (s *Service) loadUserByID(ctx context.Context, userID string) (userRecord, error) {
	var user userRecord
	err := s.db.QueryRow(ctx,
		`SELECT id, email, password_hash, display_name, role, status, must_change_password
		 FROM public.users WHERE id = $1`, userID,
	).Scan(&user.ID, &user.Email, &user.PasswordHash, &user.DisplayName, &user.Role, &user.Status, &user.MustChangePassword)
	if err != nil {
		return userRecord{}, err
	}
	return user, nil
}

// Service owns authentication: login/logout/me commands, the Instance Claim,
// self-registration, and the maintenance sweep. Session state transitions —
// token mechanics, issuance, validation, sliding refresh — are delegated to
// the session responsibility module. Reads use the pool; every write runs
// through the Write Transaction Module. setupCodeRequired mirrors the
// deployment's claim protection; setupCode holds the one-time code an armed
// protected claim demands (issue #128): written once by ArmInstanceClaim on
// construction over an empty users table, cleared the moment a claim
// succeeds, and never persisted — its lifetime is the empty instance's
// lifetime with this process.
type Service struct {
	db                *pgxpool.Pool
	runner            *writetx.Runner
	sessions          *session.Service
	limiter           *LoginRateLimiter
	setupCodeRequired bool
	setupCode         string
}

// NewService builds the service over the runtime pool, the shared write
// transaction runner, and the Module-constructed session responsibility
// module.
func NewService(db *pgxpool.Pool, runner *writetx.Runner, sessions *session.Service) *Service {
	return &Service{db: db, runner: runner, sessions: sessions, limiter: NewLoginRateLimiter()}
}
