// Real-PostgreSQL evidence for the session responsibility module (spec
// #138, ticket #140): interactive issuance with the atomic last-login
// projection, the lock-point recheck of active status and the credential
// stamp, participation in the caller's transaction (commit and rollback),
// validation's one invalid-session answer, sliding refresh — including the
// best-effort path under forced refresh failure versus fail-closed lookup
// failure — and the absence of automatic audit writes. Opt-in like the
// auth/writetx suites: the harness (scripts/test-identity-integration.sh)
// exports NEVIX_DATABASE_URL (owner) and NEVIX_IDENTITY_DATABASE_URL (the
// identity_app runtime credential); without the harness these tests skip.
package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"github.com/nevix-ai/server/internal/identity/writetx"
	"github.com/nevix-ai/server/internal/migration"
)

func requireEnv(t *testing.T, key string) string {
	t.Helper()
	value := os.Getenv(key)
	if value == "" {
		if os.Getenv("NEVIX_IDENTITY_INTEGRATION_REQUESTED") == "1" {
			t.Fatalf("identity integration was requested, but %s is not set; run ./scripts/test-identity-integration.sh from the repository root to start the supported harness", key)
		}
		t.Skipf("identity integration was not requested: %s is not set (run ./scripts/test-identity-integration.sh)", key)
	}
	return value
}

// storeHarness owns the two credentials and a store plus a caller-side
// runner, built exactly as the Module builds them, with the schema already
// at the newest version and user-system state truncated.
func storeHarness(t *testing.T, ctx context.Context) (owner, runtime *pgxpool.Pool, store *Store, runner *writetx.Runner) {
	t.Helper()
	ownerURL := requireEnv(t, "NEVIX_DATABASE_URL")
	runtimeURL := requireEnv(t, "NEVIX_IDENTITY_DATABASE_URL")
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner database: %v", err)
	}
	t.Cleanup(owner.Close)
	runtime, err = pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect runtime database: %v", err)
	}
	t.Cleanup(runtime.Close)
	if _, err := owner.Exec(ctx, `TRUNCATE public.audit_logs, public.sessions, public.join_codes, public.users`); err != nil {
		t.Fatalf("truncate user-system tables: %v", err)
	}
	runner = writetx.New(runtime)
	return owner, runtime, NewStore(runtime, runner), runner
}

// seedActiveUser inserts one active account and returns the id and the
// password hash — the credential state a caller would have verified.
func seedActiveUser(t *testing.T, owner *pgxpool.Pool, ctx context.Context, email string) (userID, passwordHash string) {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte("old-password-1"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	if err := owner.QueryRow(ctx,
		`INSERT INTO public.users (email, password_hash, display_name, role, status, must_change_password)
		 VALUES ($1, $2, $1, 'member', 'active', false) RETURNING id`,
		email, string(hash),
	).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	return userID, string(hash)
}

func countSessions(t *testing.T, owner *pgxpool.Pool, ctx context.Context) int {
	t.Helper()
	var count int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.sessions`).Scan(&count); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	return count
}

func countAuditRows(t *testing.T, owner *pgxpool.Pool, ctx context.Context) int {
	t.Helper()
	var count int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.audit_logs`).Scan(&count); err != nil {
		t.Fatalf("count audit rows: %v", err)
	}
	return count
}

// hexSHA256 mirrors the one-way mapping the store persists, so tests can
// assert the stored form against the presented token.
func hexSHA256(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

// issue runs one caller-owned write transaction whose only business work is
// issuance — the Login shape with the audit step removed.
func issue(t *testing.T, runner *writetx.Runner, ctx context.Context, store *Store, in IssueInput) (IssuedSession, error) {
	t.Helper()
	var issued IssuedSession
	err := runner.Run(ctx, func(sc *writetx.Scope) error {
		var err error
		issued, err = store.Issue(ctx, sc, in)
		return err
	})
	return issued, err
}

// Issuance inserts exactly one row storing only the token's SHA-256 hash,
// advances last_login_at atomically, answers with the opaque token and a
// ~30-day expiry, and writes no audit row. Two issuances never share a
// token.
func TestIssueInsertsSessionStampsLastLoginAndWritesNoAudit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	owner, _, store, runner := storeHarness(t, ctx)
	userID, stamp := seedActiveUser(t, owner, ctx, "issuer@nevix.test")

	first, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, DeviceName: "workstation", CredentialStamp: stamp})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if first.Token == "" {
		t.Fatal("issuance returned no token")
	}
	if remaining := time.Until(first.ExpiresAt); remaining < 29*24*time.Hour || remaining > 31*24*time.Hour {
		t.Fatalf("expiry %v away, want ~30 days", remaining)
	}

	second, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, CredentialStamp: stamp})
	if err != nil {
		t.Fatalf("second issue: %v", err)
	}
	if second.Token == first.Token {
		t.Fatal("two issuances produced the same token")
	}

	if got := countSessions(t, owner, ctx); got != 2 {
		t.Fatalf("sessions = %d, want 2", got)
	}
	var storedHash string
	if err := owner.QueryRow(ctx, `SELECT encode(token_hash, 'hex') FROM public.sessions WHERE device_name = 'workstation'`).Scan(&storedHash); err != nil {
		t.Fatalf("read stored hash: %v", err)
	}
	if storedHash != hexSHA256(first.Token) {
		t.Fatal("stored session hash is not the SHA-256 of the issued token")
	}
	var lastLogin *time.Time
	if err := owner.QueryRow(ctx, `SELECT last_login_at FROM public.users WHERE id = $1`, userID).Scan(&lastLogin); err != nil {
		t.Fatalf("read last_login_at: %v", err)
	}
	if lastLogin == nil {
		t.Fatal("issuance did not stamp last_login_at")
	}
	if got := countAuditRows(t, owner, ctx); got != 0 {
		t.Fatalf("audit rows after issuance = %d, want 0 (audit is caller-owned)", got)
	}
}

// A reset or disable committing between the caller's verification and the
// issuance lock point must void the in-flight issuance: the recheck under
// the row lock answers with the distinct domain errors and leaves no row.
func TestIssueRechecksActiveStatusAndCredentialStampUnderLock(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	owner, _, store, runner := storeHarness(t, ctx)
	userID, stamp := seedActiveUser(t, owner, ctx, "racer@nevix.test")

	// The reset commits inside the verification-to-issuance window.
	if _, err := owner.Exec(ctx, `UPDATE public.users SET password_hash = 'replacement-hash' WHERE id = $1`, userID); err != nil {
		t.Fatalf("replace password hash: %v", err)
	}
	if _, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, CredentialStamp: stamp}); !errors.Is(err, ErrStaleCredential) {
		t.Fatalf("issuance after reset: error %v, want ErrStaleCredential", err)
	}
	if got := countSessions(t, owner, ctx); got != 0 {
		t.Fatalf("sessions after refused issuance = %d, want 0", got)
	}

	// The same lock recheck refuses a disable that landed in the window.
	if _, err := owner.Exec(ctx, `UPDATE public.users SET status = 'disabled' WHERE id = $1`, userID); err != nil {
		t.Fatalf("disable user: %v", err)
	}
	if _, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, CredentialStamp: "replacement-hash"}); !errors.Is(err, ErrInactiveUser) {
		t.Fatalf("issuance after disable: error %v, want ErrInactiveUser", err)
	}
	if got := countSessions(t, owner, ctx); got != 0 {
		t.Fatalf("sessions after second refused issuance = %d, want 0", got)
	}

	// Control: an unchanged account still issues normally.
	if _, err := owner.Exec(ctx, `UPDATE public.users SET status = 'active' WHERE id = $1`, userID); err != nil {
		t.Fatalf("re-enable user: %v", err)
	}
	if _, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, CredentialStamp: "replacement-hash"}); err != nil {
		t.Fatalf("control issuance: %v", err)
	}
	if got := countSessions(t, owner, ctx); got != 1 {
		t.Fatalf("sessions after control issuance = %d, want 1", got)
	}
}

// Issuance is one participant in the caller's transaction: a later failure
// in the same callback rolls the session row and the last_login_at
// projection back together, so they can never disagree.
func TestIssueRollsBackWithTheCallerTransaction(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	owner, _, store, runner := storeHarness(t, ctx)
	userID, stamp := seedActiveUser(t, owner, ctx, "rollback@nevix.test")

	sentinel := errors.New("caller command failed after issuance")
	err := runner.Run(ctx, func(sc *writetx.Scope) error {
		if _, err := store.Issue(ctx, sc, IssueInput{UserID: userID, CredentialStamp: stamp}); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("rolled-back run: error %v, want the caller sentinel", err)
	}
	if got := countSessions(t, owner, ctx); got != 0 {
		t.Fatalf("sessions after rollback = %d, want 0", got)
	}
	var lastLogin *time.Time
	if err := owner.QueryRow(ctx, `SELECT last_login_at FROM public.users WHERE id = $1`, userID).Scan(&lastLogin); err != nil {
		t.Fatalf("read last_login_at: %v", err)
	}
	if lastLogin != nil {
		t.Fatal("last_login_at survived the rollback")
	}
	if got := countAuditRows(t, owner, ctx); got != 0 {
		t.Fatalf("audit rows after rollback = %d, want 0", got)
	}
}

// Validation resolves the session's non-sensitive identity and the user
// facts, and a session inside the refresh threshold slides forward without
// touching last_login_at.
func TestValidateResolvesIdentityAndSlidesNearExpiryWithoutTouchingLastLogin(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	owner, _, store, runner := storeHarness(t, ctx)
	userID, stamp := seedActiveUser(t, owner, ctx, "validator@nevix.test")
	issued, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, DeviceName: "laptop", CredentialStamp: stamp})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}

	identity, err := store.Validate(ctx, issued.Token)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	var dbSessionID string
	if err := owner.QueryRow(ctx, `SELECT id FROM public.sessions WHERE device_name = 'laptop'`).Scan(&dbSessionID); err != nil {
		t.Fatalf("read session id: %v", err)
	}
	if identity.SessionID != dbSessionID {
		t.Fatalf("identity SessionID %s, want the sessions row id %s", identity.SessionID, dbSessionID)
	}
	if identity.UserID != userID || identity.Email != "validator@nevix.test" || identity.Role != "member" || identity.DisplayName != "validator@nevix.test" || identity.MustChangePassword {
		t.Fatalf("identity user facts = %+v, want the seeded account", identity)
	}

	var lastLoginAfterIssue time.Time
	if err := owner.QueryRow(ctx, `SELECT last_login_at FROM public.users WHERE id = $1`, userID).Scan(&lastLoginAfterIssue); err != nil {
		t.Fatalf("read last_login_at: %v", err)
	}

	// Move the session under the refresh threshold and validate again.
	if _, err := owner.Exec(ctx,
		`UPDATE public.sessions SET expires_at = now() + interval '2 days' WHERE id = $1`, dbSessionID,
	); err != nil {
		t.Fatalf("age session: %v", err)
	}
	if _, err := store.Validate(ctx, issued.Token); err != nil {
		t.Fatalf("validate near expiry: %v", err)
	}
	var expiresAt time.Time
	if err := owner.QueryRow(ctx, `SELECT expires_at FROM public.sessions WHERE id = $1`, dbSessionID).Scan(&expiresAt); err != nil {
		t.Fatalf("read refreshed expiry: %v", err)
	}
	if remaining := time.Until(expiresAt); remaining < 29*24*time.Hour {
		t.Fatalf("expiry after use %v away, want the sliding window re-armed to ~30 days", remaining)
	}
	var lastLoginAfterRefresh time.Time
	if err := owner.QueryRow(ctx, `SELECT last_login_at FROM public.users WHERE id = $1`, userID).Scan(&lastLoginAfterRefresh); err != nil {
		t.Fatalf("re-read last_login_at: %v", err)
	}
	if !lastLoginAfterRefresh.Equal(lastLoginAfterIssue) {
		t.Fatal("sliding refresh advanced last_login_at; it is the interactive-issuance projection only")
	}
}

// Unknown, expired, revoked, and disabled all answer the one invalid-session
// error. A validation lookup failure stays a distinguishable infrastructure
// error (fail closed), while a forced refresh failure never rejects a
// currently valid session.
func TestValidateFailuresAndBestEffortRefresh(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	owner, _, _, runner := storeHarness(t, ctx)
	userID, stamp := seedActiveUser(t, owner, ctx, "failures@nevix.test")

	// Dedicated pools so the two failure modes can be forced deterministically
	// without disturbing the shared harness pools: closing readPool forces the
	// lookup failure; closing refreshPool forces only the refresh failure.
	runtimeURL := requireEnv(t, "NEVIX_IDENTITY_DATABASE_URL")
	readPool, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect read pool: %v", err)
	}
	t.Cleanup(readPool.Close)
	refreshPool, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect refresh pool: %v", err)
	}
	t.Cleanup(refreshPool.Close)
	store := NewStore(readPool, writetx.New(refreshPool))

	if _, err := store.Validate(ctx, "unknown-token"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown token: error %v, want ErrInvalid", err)
	}

	issued, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, CredentialStamp: stamp})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}

	// Expired: rejected before any cleanup runs.
	var sessionID string
	if err := owner.QueryRow(ctx, `SELECT id FROM public.sessions WHERE user_id = $1`, userID).Scan(&sessionID); err != nil {
		t.Fatalf("read session id: %v", err)
	}
	if _, err := owner.Exec(ctx, `UPDATE public.sessions SET expires_at = now() - interval '1 hour' WHERE id = $1`, sessionID); err != nil {
		t.Fatalf("expire session: %v", err)
	}
	if _, err := store.Validate(ctx, issued.Token); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expired session: error %v, want ErrInvalid", err)
	}

	// Revoked: the row is gone.
	if _, err := owner.Exec(ctx, `DELETE FROM public.sessions WHERE id = $1`, sessionID); err != nil {
		t.Fatalf("revoke session: %v", err)
	}
	if _, err := store.Validate(ctx, issued.Token); !errors.Is(err, ErrInvalid) {
		t.Fatalf("revoked session: error %v, want ErrInvalid", err)
	}

	// Disabled account: a still-valid session answers the same one error.
	issued, err = issue(t, runner, ctx, store, IssueInput{UserID: userID, CredentialStamp: stamp})
	if err != nil {
		t.Fatalf("reissue: %v", err)
	}
	if _, err := owner.Exec(ctx, `UPDATE public.users SET status = 'disabled' WHERE id = $1`, userID); err != nil {
		t.Fatalf("disable user: %v", err)
	}
	if _, err := store.Validate(ctx, issued.Token); !errors.Is(err, ErrInvalid) {
		t.Fatalf("disabled account: error %v, want ErrInvalid", err)
	}
	if _, err := owner.Exec(ctx, `UPDATE public.users SET status = 'active' WHERE id = $1`, userID); err != nil {
		t.Fatalf("re-enable user: %v", err)
	}

	// Forced refresh failure: a currently valid session is still accepted.
	if err := owner.QueryRow(ctx, `SELECT id FROM public.sessions WHERE user_id = $1`, userID).Scan(&sessionID); err != nil {
		t.Fatalf("read reissued session id: %v", err)
	}
	if _, err := owner.Exec(ctx, `UPDATE public.sessions SET expires_at = now() + interval '2 days' WHERE id = $1`, sessionID); err != nil {
		t.Fatalf("age session: %v", err)
	}
	refreshPool.Close()
	if _, err := store.Validate(ctx, issued.Token); err != nil {
		t.Fatalf("validate with dead refresh path: %v, want the valid session accepted", err)
	}

	// Forced lookup failure: fail closed with a distinguishable error.
	readPool.Close()
	if _, err := store.Validate(ctx, issued.Token); err == nil || errors.Is(err, ErrInvalid) {
		t.Fatalf("validate with dead lookup: error %v, want a non-ErrInvalid infrastructure error", err)
	}
}
