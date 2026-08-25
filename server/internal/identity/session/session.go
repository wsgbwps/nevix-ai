// Package session owns production Session state transitions. Issuance and
// revocation participate in the caller's open writetx.Scope and never begin,
// commit, roll back, or retry that transaction. Command rules, authorization,
// audit semantics, and HTTP mapping remain with callers.
package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/identity/writetx"
)

const (
	// TTL is the 30-day sliding window: every use within the last
	// refreshThreshold re-arms the expiry to now + TTL.
	TTL = 30 * 24 * time.Hour
	// refreshThreshold is the remaining lifetime below which an authenticated
	// use refreshes the session.
	refreshThreshold = 15 * 24 * time.Hour
	// tokenBytes is the entropy of an opaque session token.
	tokenBytes = 32
)

// Issuance domain errors: the caller decides command-level semantics (which
// HTTP status, which audit action) for each.
var (
	// ErrInactiveUser reports issuance reached its lock point against an
	// account that is no longer active.
	ErrInactiveUser = errors.New("session: account is not active")
	// ErrStaleCredential reports the account's credential state changed
	// between the caller's verification and the issuance lock point.
	ErrStaleCredential = errors.New("session: credential changed since verification")
)

// ErrInvalid reports validation of a presented token found no usable session:
// the token is unknown, expired, or revoked, or its account is disabled. One
// answer by design — the guard's 401 never distinguishes the cause. Any other
// validation error is infrastructure noise the caller must fail closed on.
var ErrInvalid = errors.New("session: invalid session")

// Service is the concrete session implementation over the runtime pool and
// the Write Transaction Module. Reads use the pool; the best-effort sliding
// refresh runs as its own write transaction; issuance and revocation
// participate in the caller's open transaction through writetx.Scope.
type Service struct {
	db     *pgxpool.Pool
	runner *writetx.Runner
}

// NewService builds the service over the runtime pool and the shared write
// transaction runner.
func NewService(db *pgxpool.Pool, runner *writetx.Runner) *Service {
	return &Service{db: db, runner: runner}
}

// NewToken returns a fresh opaque bearer token (base64url) and the SHA-256
// hash persisted in the sessions table. The token itself is never stored.
func NewToken() (string, []byte, error) {
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, fmt.Errorf("session: generate token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	return token, hashToken(token), nil
}

// hashToken is the one-way mapping from bearer token to stored hash.
func hashToken(token string) []byte {
	digest := sha256.Sum256([]byte(token))
	return digest[:]
}

// IssueInput is what interactive issuance receives: the target user, the
// device name, and a credential equality stamp — the credential state the
// caller already verified (Login) or created (Instance Claim, registration).
// It never carries a plaintext credential and issuance never re-verifies one;
// the stamp is only compared for equality under the account's row lock.
type IssueInput struct {
	UserID          string
	DeviceName      string
	CredentialStamp string
}

// IssuedSession is the caller-visible issuance result: the opaque token to
// present and the server-computed expiry. Session row identity, hash, and
// timestamps stay internal.
type IssuedSession struct {
	Token     string
	ExpiresAt time.Time
}

// Issue inserts one interactive session and advances the account's
// last_login_at — the projection of the most recent successful interactive
// issuance (server/CONTEXT.md) — as one atomic participant in the caller's
// open Write Transaction. The account row is locked first and re-checked —
// status still active, stored credential state still equal to the stamp — so
// a disable or password reset that committed while this issuance was in
// flight can never leave a stale session behind. It writes no audit entry:
// audit semantics belong to the command that called it.
func (s *Service) Issue(ctx context.Context, sc *writetx.Scope, in IssueInput) (IssuedSession, error) {
	tx := sc.Tx()
	var currentStamp, status string
	if err := tx.QueryRow(ctx,
		`SELECT password_hash, status FROM public.users WHERE id = $1 FOR UPDATE`, in.UserID,
	).Scan(&currentStamp, &status); err != nil {
		return IssuedSession{}, fmt.Errorf("session: lock account for issuance: %w", err)
	}
	if status != "active" {
		return IssuedSession{}, ErrInactiveUser
	}
	if currentStamp != in.CredentialStamp {
		return IssuedSession{}, ErrStaleCredential
	}
	token, tokenHash, err := NewToken()
	if err != nil {
		return IssuedSession{}, err
	}
	var expiresAt time.Time
	if err := tx.QueryRow(ctx,
		`INSERT INTO public.sessions (user_id, token_hash, device_name, expires_at)
		 VALUES ($1, $2, $3, now() + make_interval(secs => $4))
		 RETURNING expires_at`,
		in.UserID, tokenHash, in.DeviceName, TTL.Seconds(),
	).Scan(&expiresAt); err != nil {
		return IssuedSession{}, fmt.Errorf("session: insert session: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE public.users SET last_login_at = now() WHERE id = $1`, in.UserID,
	); err != nil {
		return IssuedSession{}, fmt.Errorf("session: stamp last login: %w", err)
	}
	return IssuedSession{Token: token, ExpiresAt: expiresAt}, nil
}

// ValidatedSession is the non-sensitive validated-session identity plus the
// user facts authorization needs. The stored token hash never crosses this
// seam.
type ValidatedSession struct {
	// SessionID is the sessions row's uuid — the identity revocation and
	// effect routing key on, never a bearer-derived secret.
	SessionID          string
	UserID             string
	Email              string
	DisplayName        string
	Role               string
	MustChangePassword bool
}

// Validate resolves one presented opaque token to its ValidatedSession.
// Hashing, lookup, expiry, active-account checking, and the refresh threshold
// are one owned step here: unknown, expired, or revoked sessions and disabled
// accounts all answer ErrInvalid; any other error is infrastructure noise the
// caller fails closed on. A session inside the refresh threshold is slid
// forward best-effort: a refresh failure is logged and never rejects an
// otherwise valid authentication, and refresh never touches last_login_at.
func (s *Service) Validate(ctx context.Context, token string) (ValidatedSession, error) {
	var validated ValidatedSession
	var expiresAt time.Time
	err := s.db.QueryRow(ctx,
		`SELECT s.id, u.id, u.email, u.display_name, u.role, u.must_change_password, s.expires_at
		 FROM public.sessions AS s
		 JOIN public.users AS u ON u.id = s.user_id
		 WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
		hashToken(token),
	).Scan(&validated.SessionID, &validated.UserID, &validated.Email, &validated.DisplayName, &validated.Role, &validated.MustChangePassword, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ValidatedSession{}, ErrInvalid
	}
	if err != nil {
		return ValidatedSession{}, fmt.Errorf("session: load session: %w", err)
	}
	if time.Until(expiresAt) < refreshThreshold {
		s.refresh(ctx, validated.SessionID)
	}
	return validated, nil
}

// refresh slides the expiry window forward on an authenticated use. Best
// effort: the session stays valid per its committed row even if the refresh
// write fails, so the failure is logged, not propagated.
func (s *Service) refresh(ctx context.Context, sessionID string) {
	err := s.runner.Run(ctx, func(sc *writetx.Scope) error {
		tx := sc.Tx()
		_, err := tx.Exec(ctx,
			`UPDATE public.sessions
			 SET expires_at = now() + make_interval(secs => $1), last_used_at = now()
			 WHERE id = $2`,
			TTL.Seconds(), sessionID)
		return err
	})
	if err != nil {
		slog.Warn("identity: sliding session refresh failed; session keeps its current expiry", "error", err)
	}
}

// SweepExpired removes expired rows through the Write Transaction Module.
// Logical expiry remains enforced by Validate, so cleanup failure cannot
// extend a session's validity. The caller owns retry policy.
func (s *Service) SweepExpired(ctx context.Context) error {
	err := s.runner.Run(ctx, func(sc *writetx.Scope) error {
		_, err := sc.Tx().Exec(ctx, `DELETE FROM public.sessions WHERE expires_at < now()`)
		return err
	})
	if err != nil {
		return fmt.Errorf("session: sweep expired sessions: %w", err)
	}
	return nil
}

// RevocationTarget is a closed set covering the current session, a user's
// other sessions, or all of a user's sessions. Its constructors prevent
// invalid or accidentally widened combinations.
type RevocationTarget interface {
	isRevocationTarget()
}

// currentSession is the current target: exactly one session identity.
type currentSession struct{ sessionID string }

// otherSessions is the others target: every session of one user except the
// named current session.
type otherSessions struct {
	userID          string
	exceptSessionID string
}

// allUserSessions is the all target: every session of one user.
type allUserSessions struct{ userID string }

func (currentSession) isRevocationTarget()  {}
func (otherSessions) isRevocationTarget()   {}
func (allUserSessions) isRevocationTarget() {}

// Current targets exactly the session identity a caller carries as current —
// for Logout, the guard-resolved principal's non-sensitive SessionID. An
// absent identity is not a target: construction refuses it rather than
// letting a wiring bug masquerade as a no-op or a wider revocation.
func Current(sessionID string) (RevocationTarget, error) {
	if sessionID == "" {
		return nil, fmt.Errorf("session: current revocation target needs a session identity")
	}
	return currentSession{sessionID: sessionID}, nil
}

// Others targets every session of userID except the named current session —
// the disposition a self-service password change applies to the caller's
// other devices. Both identities are required: without its user or its
// surviving current session the disposition would silently widen to all.
func Others(userID, exceptSessionID string) (RevocationTarget, error) {
	if userID == "" || exceptSessionID == "" {
		return nil, fmt.Errorf("session: others revocation target needs a user and its current session identity")
	}
	return otherSessions{userID: userID, exceptSessionID: exceptSessionID}, nil
}

// All targets every session of one user — the disposition a disable or an
// admin password reset applies. A target without its user is refused.
func All(userID string) (RevocationTarget, error) {
	if userID == "" {
		return nil, fmt.Errorf("session: all revocation target needs a user identity")
	}
	return allUserSessions{userID: userID}, nil
}

// Revoke deletes exactly the target's durable sessions inside the caller's
// open Write Transaction. An absent target is a successful no-op with no
// post-commit effect; after a change, the exact session IDs are logged only
// after commit. Audit semantics remain with the calling command.
func (s *Service) Revoke(ctx context.Context, sc *writetx.Scope, target RevocationTarget) (bool, error) {
	revoked, err := s.deleteTargeted(ctx, sc, target)
	if err != nil {
		return false, err
	}
	if len(revoked) == 0 {
		return false, nil
	}
	sort.Strings(revoked)
	sc.AfterCommit(func() {
		slog.Info("identity: session revocation committed", "session_ids", revoked)
	})
	return true, nil
}

// deleteTargeted runs the target's exact DELETE and returns the revoked
// session identities it reports, in database order until Revoke normalizes
// them.
func (s *Service) deleteTargeted(ctx context.Context, sc *writetx.Scope, target RevocationTarget) ([]string, error) {
	var query string
	var args []any
	switch t := target.(type) {
	case currentSession:
		query = `DELETE FROM public.sessions WHERE id = $1 RETURNING id`
		args = []any{t.sessionID}
	case otherSessions:
		query = `DELETE FROM public.sessions WHERE user_id = $1 AND id <> $2 RETURNING id`
		args = []any{t.userID, t.exceptSessionID}
	case allUserSessions:
		query = `DELETE FROM public.sessions WHERE user_id = $1 RETURNING id`
		args = []any{t.userID}
	default:
		// Unreachable for the closed variants; a nil target is a caller bug
		// that must not masquerade as a successful no-op.
		return nil, fmt.Errorf("session: unsupported revocation target %T", target)
	}
	rows, err := sc.Tx().Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("session: revoke sessions: %w", err)
	}
	defer rows.Close()
	var revoked []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("session: read revoked session: %w", err)
		}
		revoked = append(revoked, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("session: revoke sessions: %w", err)
	}
	return revoked, nil
}
