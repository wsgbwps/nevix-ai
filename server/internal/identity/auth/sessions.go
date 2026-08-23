// Session token mechanics and the session store: opaque bearer tokens whose
// SHA-256 hash is the only persisted form, lookup joined against the user for
// guard authentication, sliding expiry refresh, revocation, and the retention
// sweep. All writes run through the Write Transaction Module (ADR-0015).
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/writetx"
)

const (
	// sessionTTL is the 30-day sliding window: every use within the last
	// sessionRefreshThreshold re-arms the expiry to now + sessionTTL.
	sessionTTL = 30 * 24 * time.Hour
	// sessionRefreshThreshold is the remaining lifetime below which an
	// authenticated use refreshes the session.
	sessionRefreshThreshold = 15 * 24 * time.Hour
	// sessionTokenBytes is the entropy of an opaque session token.
	sessionTokenBytes = 32
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

// newSessionToken returns the opaque bearer token (base64url) and the SHA-256
// hash persisted in the sessions table. The token itself is never stored.
func newSessionToken() (string, []byte, error) {
	raw := make([]byte, sessionTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, fmt.Errorf("auth: generate session token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	return token, hashSessionToken(token), nil
}

// hashSessionToken is the one-way mapping from bearer token to stored hash.
func hashSessionToken(token string) []byte {
	digest := sha256.Sum256([]byte(token))
	return digest[:]
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
// (authz.SessionAuthenticator). Unknown, expired, or revoked sessions and
// disabled accounts all answer authz.ErrNotAuthenticated; any other error is
// infrastructure noise the guard answers with 500.
func (s *Service) Authenticate(r *http.Request) (authz.Principal, error) {
	token, ok := bearerToken(r)
	if !ok {
		return authz.Principal{}, authz.ErrNotAuthenticated
	}
	hash := hashSessionToken(token)

	var principal authz.Principal
	var expiresAt time.Time
	err := s.db.QueryRow(r.Context(),
		`SELECT u.id, u.email, u.display_name, u.role, u.must_change_password, s.expires_at
		 FROM public.sessions AS s
		 JOIN public.users AS u ON u.id = s.user_id
		 WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
		hash,
	).Scan(&principal.UserID, &principal.Email, &principal.DisplayName, &principal.Role, &principal.MustChangePassword, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return authz.Principal{}, authz.ErrNotAuthenticated
	}
	if err != nil {
		return authz.Principal{}, fmt.Errorf("auth: load session: %w", err)
	}
	principal.SessionTokenHash = hash

	if time.Until(expiresAt) < sessionRefreshThreshold {
		s.refreshSession(r.Context(), hash)
	}
	return principal, nil
}

// refreshSession slides the expiry window forward on an authenticated use.
// Best effort: the session stays valid per its committed row even if the
// refresh write fails, so the failure is logged, not propagated.
func (s *Service) refreshSession(ctx context.Context, tokenHash []byte) {
	err := s.runner.Run(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE public.sessions
			 SET expires_at = now() + make_interval(secs => $1), last_used_at = now()
			 WHERE token_hash = $2`,
			sessionTTL.Seconds(), tokenHash)
		return err
	})
	if err != nil {
		slog.Warn("identity: sliding session refresh failed; session keeps its current expiry", "error", err)
	}
}

// issueSession inserts one session row, stamps the account's last_login_at,
// and writes the audit entry in a single write transaction, returning the
// server-computed expiry. The transaction first re-verifies the account
// under its row lock — status still active and the stored password hash
// still the one Login verified — so a reset-password or disable that commits
// while this login is in flight can never leave a stale-credential session
// behind (ADR-0015 revocation immediacy). last_login_at is the durable "has
// ever logged in" marker admin deletion keys on (issue #102), so it rides
// the same commit as the session. The audit actor is snapshotted inside the
// transaction (ADR-0009): the display name recorded is the one committed at
// write time, not one read before the transaction.
func (s *Service) issueSession(ctx context.Context, user userRecord, tokenHash []byte, deviceName string) (time.Time, error) {
	var expiresAt time.Time
	err := s.runner.Run(ctx, func(tx pgx.Tx) error {
		var currentHash, status string
		if err := tx.QueryRow(ctx,
			`SELECT password_hash, status FROM public.users WHERE id = $1 FOR UPDATE`, user.ID,
		).Scan(&currentHash, &status); err != nil {
			return fmt.Errorf("auth: lock account for session issuance: %w", err)
		}
		if status != "active" {
			return errAccountDisabled
		}
		if currentHash != user.PasswordHash {
			// The credential changed between verification and this
			// transaction (an admin reset landed in between): the same uniform
			// answer as any other wrong password.
			return errInvalidCredentials
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO public.sessions (user_id, token_hash, device_name, expires_at)
			 VALUES ($1, $2, $3, now() + make_interval(secs => $4))
			 RETURNING expires_at`,
			user.ID, tokenHash, deviceName, sessionTTL.Seconds(),
		).Scan(&expiresAt); err != nil {
			return fmt.Errorf("auth: insert session: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE public.users SET last_login_at = now() WHERE id = $1`, user.ID,
		); err != nil {
			return fmt.Errorf("auth: stamp last login: %w", err)
		}
		actor, err := audit.SnapshotSubject(ctx, tx, user.ID)
		if err != nil {
			return err
		}
		metadata := map[string]string{}
		if deviceName != "" {
			metadata["device_name"] = deviceName
		}
		if err := audit.Write(ctx, tx, audit.Entry{
			Actor:    actor,
			Action:   audit.SessionCreated,
			Metadata: metadata,
		}); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return time.Time{}, err
	}
	return expiresAt, nil
}

// revokeSession deletes exactly one session row and writes its audit entry
// when a row was actually removed; revoking an already-gone session is a
// successful no-op logout.
func (s *Service) revokeSession(ctx context.Context, principal authz.Principal) error {
	return s.runner.Run(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM public.sessions WHERE token_hash = $1`, principal.SessionTokenHash)
		if err != nil {
			return fmt.Errorf("auth: delete session: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		actor, err := audit.SnapshotSubject(ctx, tx, principal.UserID)
		if err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.Entry{
			Actor:  actor,
			Action: audit.SessionRevoked,
		})
	})
}

// sweepOnce deletes expired sessions, sweeps audit rows past the 365-day
// retention window (ADR-0009), and prunes the login limiter — the daily
// maintenance owned by the module's worker loop.
func (s *Service) sweepOnce(ctx context.Context) {
	err := s.runner.Run(ctx, func(tx pgx.Tx) error {
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

// Service owns authentication: session lifecycle, login/logout/me commands,
// bootstrap, and the maintenance sweep. Reads use the pool; every write runs
// through the Write Transaction Module. setupCode holds the first-run setup
// code (issue #122): written once by GenerateSetupCode on construction over
// an empty users table and never mutated after, its lifetime is the process —
// the initialize transaction's empty-table re-check is what retires it.
type Service struct {
	db        *pgxpool.Pool
	runner    *writetx.Runner
	limiter   *LoginRateLimiter
	setupCode string
}

// NewService builds the service over the runtime pool and the shared write
// transaction runner.
func NewService(db *pgxpool.Pool, runner *writetx.Runner) *Service {
	return &Service{db: db, runner: runner, limiter: NewLoginRateLimiter()}
}
