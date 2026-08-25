// Package session is the Identity Module's Session responsibility module: the
// one trusted implementation of production session state transitions. It owns
// opaque token generation and hashing, the TTL/sliding-refresh/expiry policy,
// interactive session issuance with the atomic last-login projection, session
// validation, and best-effort sliding refresh. Callers keep command rules,
// authorization, business locks, audit semantics, and HTTP mapping: issuance
// participates in the caller's already-open Write Transaction through the
// writetx.Scope it receives, and the package never starts, commits, rolls
// back, or retries a transaction of its own. Reads and the refresh write go
// through the pool and the Write Transaction Module exactly like the callers
// it replaces. PostgreSQL is used directly; there is deliberately no
// repository interface, DAO, or test double (spec #138).
package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
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

// Store is the concrete session implementation over the runtime pool and the
// Write Transaction Module. Reads use the pool; the sliding refresh runs as
// one write transaction; issuance participates in the caller's transaction.
type Store struct {
	db     *pgxpool.Pool
	runner *writetx.Runner
}

// NewStore builds the store over the runtime pool and the shared write
// transaction runner.
func NewStore(db *pgxpool.Pool, runner *writetx.Runner) *Store {
	return &Store{db: db, runner: runner}
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
func (s *Store) Issue(ctx context.Context, sc *writetx.Scope, in IssueInput) (IssuedSession, error) {
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

// Identity is the non-sensitive session identity plus the user facts
// authorization needs. The stored token hash never crosses this seam.
type Identity struct {
	// SessionID is the sessions row's uuid — the identity revocation and
	// effect routing key on, never a bearer-derived secret.
	SessionID          string
	UserID             string
	Email              string
	DisplayName        string
	Role               string
	MustChangePassword bool
}

// Validate resolves one presented opaque token to the session's Identity.
// Hashing, lookup, expiry, active-account checking, and the refresh threshold
// are one owned step here: unknown, expired, or revoked sessions and disabled
// accounts all answer ErrInvalid; any other error is infrastructure noise the
// caller fails closed on. A session inside the refresh threshold is slid
// forward best-effort: a refresh failure is logged and never rejects an
// otherwise valid authentication, and refresh never touches last_login_at.
func (s *Store) Validate(ctx context.Context, token string) (Identity, error) {
	var identity Identity
	var expiresAt time.Time
	err := s.db.QueryRow(ctx,
		`SELECT s.id, u.id, u.email, u.display_name, u.role, u.must_change_password, s.expires_at
		 FROM public.sessions AS s
		 JOIN public.users AS u ON u.id = s.user_id
		 WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
		hashToken(token),
	).Scan(&identity.SessionID, &identity.UserID, &identity.Email, &identity.DisplayName, &identity.Role, &identity.MustChangePassword, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Identity{}, ErrInvalid
	}
	if err != nil {
		return Identity{}, fmt.Errorf("session: load session: %w", err)
	}
	if time.Until(expiresAt) < refreshThreshold {
		s.refresh(ctx, identity.SessionID)
	}
	return identity, nil
}

// refresh slides the expiry window forward on an authenticated use. Best
// effort: the session stays valid per its committed row even if the refresh
// write fails, so the failure is logged, not propagated.
func (s *Store) refresh(ctx context.Context, sessionID string) {
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
