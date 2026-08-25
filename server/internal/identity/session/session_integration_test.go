// Real-PostgreSQL evidence for the session responsibility module (spec
// #138, tickets #140/#141): interactive issuance with the atomic last-login
// projection, the lock-point recheck of active status and the credential
// stamp, participation in the caller's transaction (commit and rollback),
// validation's one invalid-session answer, sliding refresh — including the
// best-effort path under forced refresh failure versus fail-closed lookup
// failure — the current/others/all revocation dispositions with their exact
// post-commit effect (changed/no-op, rollback safety), the expired-session
// sweep (expiry enforced before deletion; a forced cleanup outage never
// extends validity), and the absence of automatic audit writes. Opt-in like
// the auth/writetx suites: the harness
// (scripts/test-identity-integration.sh) exports NEVIX_DATABASE_URL (owner)
// and NEVIX_IDENTITY_DATABASE_URL (the identity_app runtime credential);
// without the harness these tests skip.
package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"slices"
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
func storeHarness(t *testing.T, ctx context.Context) (owner, runtime *pgxpool.Pool, store *Service, runner *writetx.Runner) {
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
	return owner, runtime, NewService(runtime, runner), runner
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
func issue(t *testing.T, runner *writetx.Runner, ctx context.Context, store *Service, in IssueInput) (IssuedSession, error) {
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

	validated, err := store.Validate(ctx, issued.Token)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	var dbSessionID string
	if err := owner.QueryRow(ctx, `SELECT id FROM public.sessions WHERE device_name = 'laptop'`).Scan(&dbSessionID); err != nil {
		t.Fatalf("read session id: %v", err)
	}
	if validated.SessionID != dbSessionID {
		t.Fatalf("validated SessionID %s, want the sessions row id %s", validated.SessionID, dbSessionID)
	}
	if validated.UserID != userID || validated.Email != "validator@nevix.test" || validated.Role != "member" || validated.DisplayName != "validator@nevix.test" || validated.MustChangePassword {
		t.Fatalf("validated user facts = %+v, want the seeded account", validated)
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
	store := NewService(readPool, writetx.New(refreshPool))

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

// committedEffect is one post-commit revocation dispatch observed through
// the real production log: the exact affected session identities and how
// many of their rows were still visible when the effect ran (zero: the
// commit precedes the effect).
type committedEffect struct {
	sessionIDs []string
	visible    int
}

// logRecorder captures the default logger's records so package tests
// observe the real production effect dispatch — no production seam exists
// for it, and none is added for tests. It also proves timing: at dispatch
// time it queries the committed table through the owner pool.
type logRecorder struct {
	owner   *pgxpool.Pool
	effects []committedEffect
}

// captureLogs swaps the default logger for the recorder and restores it on
// cleanup. Tests in this package run sequentially, so the swap is safe.
func captureLogs(t *testing.T, owner *pgxpool.Pool) *logRecorder {
	t.Helper()
	recorder := &logRecorder{owner: owner}
	previous := slog.Default()
	slog.SetDefault(slog.New(recorder))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return recorder
}

// Handle records the session-revocation dispatches; other records are
// ignored.
func (r *logRecorder) Handle(_ context.Context, rec slog.Record) error {
	if rec.Message != "identity: session revocation committed" {
		return nil
	}
	var ids []string
	rec.Attrs(func(a slog.Attr) bool {
		if a.Key == "session_ids" {
			if value, ok := a.Value.Any().([]string); ok {
				ids = value
			}
		}
		return true
	})
	if ids == nil {
		return nil
	}
	var visible int
	if err := r.owner.QueryRow(context.Background(),
		`SELECT count(*) FROM public.sessions WHERE id::text = ANY($1)`, ids,
	).Scan(&visible); err != nil {
		return err
	}
	r.effects = append(r.effects, committedEffect{sessionIDs: ids, visible: visible})
	return nil
}

func (r *logRecorder) Enabled(_ context.Context, _ slog.Level) bool { return true }
func (r *logRecorder) WithAttrs([]slog.Attr) slog.Handler           { return r }
func (r *logRecorder) WithGroup(string) slog.Handler                { return r }

// sessionIDByDevice reads one durable session identity by its device name.
func sessionIDByDevice(t *testing.T, owner *pgxpool.Pool, ctx context.Context, deviceName string) string {
	t.Helper()
	var id string
	if err := owner.QueryRow(ctx, `SELECT id FROM public.sessions WHERE device_name = $1`, deviceName).Scan(&id); err != nil {
		t.Fatalf("read session id for %q: %v", deviceName, err)
	}
	return id
}

// The three dispositions delete exactly their closed target, answer changed
// only when durable state moved, write no audit row of their own, and hand
// the exact revoked identities to the post-commit effect — which observes
// the rows already gone, proving the effect runs after the commit.
func TestRevokeCoversCurrentOthersAndAllDispositions(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	owner, _, store, runner := storeHarness(t, ctx)
	userID, stamp := seedActiveUser(t, owner, ctx, "revoker@nevix.test")

	laptop, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, DeviceName: "laptop", CredentialStamp: stamp})
	if err != nil {
		t.Fatalf("issue laptop: %v", err)
	}
	tablet, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, DeviceName: "tablet", CredentialStamp: stamp})
	if err != nil {
		t.Fatalf("issue tablet: %v", err)
	}
	phone, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, DeviceName: "phone", CredentialStamp: stamp})
	if err != nil {
		t.Fatalf("issue phone: %v", err)
	}
	laptopID := sessionIDByDevice(t, owner, ctx, "laptop")
	tabletID := sessionIDByDevice(t, owner, ctx, "tablet")
	phoneID := sessionIDByDevice(t, owner, ctx, "phone")

	// The real production dispatch is observed through the default logger:
	// each committed batch and the rows still visible at effect time (must
	// be zero: commit precedes the effect).
	logs := captureLogs(t, owner)
	batches := func() [][]string {
		var ids [][]string
		for _, effect := range logs.effects {
			ids = append(ids, effect.sessionIDs)
		}
		return ids
	}
	revoke := func(target RevocationTarget, err error) bool {
		t.Helper()
		if err != nil {
			t.Fatalf("construct revocation target: %v", err)
		}
		var changed bool
		if err := runner.Run(ctx, func(sc *writetx.Scope) error {
			var err error
			changed, err = store.Revoke(ctx, sc, target)
			return err
		}); err != nil {
			t.Fatalf("revoke %T: %v", target, err)
		}
		return changed
	}
	countUserSessions := func() int {
		t.Helper()
		var count int
		if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.sessions WHERE user_id = $1`, userID).Scan(&count); err != nil {
			t.Fatalf("count user sessions: %v", err)
		}
		return count
	}

	// others: every session of the user except the named current one.
	if !revoke(Others(userID, laptopID)) {
		t.Fatal("others revocation of two live sessions reported no change")
	}
	if got := countUserSessions(); got != 1 {
		t.Fatalf("sessions after others = %d, want 1 (the current one)", got)
	}
	if _, err := store.Validate(ctx, laptop.Token); err != nil {
		t.Fatalf("current session after others: %v, want still valid", err)
	}
	if _, err := store.Validate(ctx, tablet.Token); !errors.Is(err, ErrInvalid) {
		t.Fatalf("tablet after others: error %v, want ErrInvalid", err)
	}
	if _, err := store.Validate(ctx, phone.Token); !errors.Is(err, ErrInvalid) {
		t.Fatalf("phone after others: error %v, want ErrInvalid", err)
	}
	if got := len(batches()); got != 1 {
		t.Fatalf("effect batches after others = %d, want 1", got)
	} else {
		want := []string{phoneID, tabletID}
		slices.Sort(want)
		if !slices.Equal(batches()[0], want) {
			t.Fatalf("others effect batch = %v, want exactly %v", batches()[0], want)
		}
		if logs.effects[0].visible != 0 {
			t.Fatalf("others effect saw %d affected rows still present, want 0 (commit precedes effect)", logs.effects[0].visible)
		}
	}

	// current: exactly the one named session.
	if !revoke(Current(laptopID)) {
		t.Fatal("current revocation of the live session reported no change")
	}
	if got := countUserSessions(); got != 0 {
		t.Fatalf("sessions after current = %d, want 0", got)
	}
	if _, err := store.Validate(ctx, laptop.Token); !errors.Is(err, ErrInvalid) {
		t.Fatalf("laptop after current: error %v, want ErrInvalid", err)
	}
	if got := len(batches()); got != 2 {
		t.Fatalf("effect batches after current = %d, want 2", got)
	} else if !slices.Equal(batches()[1], []string{laptopID}) {
		t.Fatalf("current effect batch = %v, want exactly [%s]", batches()[1], laptopID)
	}

	// all: every session of the user.
	if _, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, DeviceName: "desktop", CredentialStamp: stamp}); err != nil {
		t.Fatalf("issue desktop: %v", err)
	}
	if _, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, DeviceName: "kiosk", CredentialStamp: stamp}); err != nil {
		t.Fatalf("issue kiosk: %v", err)
	}
	desktopID := sessionIDByDevice(t, owner, ctx, "desktop")
	kioskID := sessionIDByDevice(t, owner, ctx, "kiosk")
	if !revoke(All(userID)) {
		t.Fatal("all revocation of two live sessions reported no change")
	}
	if got := countUserSessions(); got != 0 {
		t.Fatalf("sessions after all = %d, want 0", got)
	}
	if got := len(batches()); got != 3 {
		t.Fatalf("effect batches after all = %d, want 3", got)
	} else {
		want := []string{desktopID, kioskID}
		slices.Sort(want)
		if !slices.Equal(batches()[2], want) {
			t.Fatalf("all effect batch = %v, want exactly %v", batches()[2], want)
		}
		if logs.effects[2].visible != 0 {
			t.Fatalf("all effect saw %d affected rows still present, want 0 (commit precedes effect)", logs.effects[2].visible)
		}
	}

	// Empty targets: every disposition is a successful no-op — no change, no
	// effect, no audit row.
	if revoke(Current(laptopID)) {
		t.Fatal("current revocation of an absent session reported a change")
	}
	if revoke(Others(userID, laptopID)) {
		t.Fatal("others revocation with no other sessions reported a change")
	}
	if revoke(All(userID)) {
		t.Fatal("all revocation of a sessionless user reported a change")
	}
	if got := len(batches()); got != 3 {
		t.Fatalf("effect batches after no-ops = %d, want still 3", got)
	}
	if got := countAuditRows(t, owner, ctx); got != 0 {
		t.Fatalf("audit rows after revocations = %d, want 0 (audit is caller-owned)", got)
	}
}

// Revoking an absent target from the start stays the defined no-op: no
// durable change, no registered effect, no audit write.
func TestRevokeIsANoOpForAbsentTargets(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	owner, _, store, runner := storeHarness(t, ctx)
	userID, _ := seedActiveUser(t, owner, ctx, "absent@nevix.test")

	logs := captureLogs(t, owner)
	assertNoOp := func(target RevocationTarget, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("construct revocation target: %v", err)
		}
		var changed bool
		if err := runner.Run(ctx, func(sc *writetx.Scope) error {
			var err error
			changed, err = store.Revoke(ctx, sc, target)
			return err
		}); err != nil {
			t.Fatalf("revoke %T: %v", target, err)
		}
		if changed {
			t.Fatalf("revocation of absent target %T reported a change", target)
		}
	}
	assertNoOp(Current("00000000-0000-0000-0000-000000000001"))
	assertNoOp(Others(userID, "00000000-0000-0000-0000-000000000002"))
	assertNoOp(All(userID))
	if got := len(logs.effects); got != 0 {
		t.Fatalf("absent targets dispatched %d effects, want 0", got)
	}
	if got := countSessions(t, owner, ctx); got != 0 {
		t.Fatalf("sessions after no-op revocations = %d, want 0", got)
	}
	if got := countAuditRows(t, owner, ctx); got != 0 {
		t.Fatalf("audit rows after no-op revocations = %d, want 0", got)
	}
}

// Revocation participates in the caller's transaction: a later failure or
// panic in the same callback rolls the deletion back — the sessions survive,
// the post-commit effect never runs, and no audit row appears.
func TestRevokeRollsBackWithTheCallerTransactionAndSkipsTheEffect(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	owner, _, store, runner := storeHarness(t, ctx)
	userID, stamp := seedActiveUser(t, owner, ctx, "rollback-revoker@nevix.test")

	first, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, DeviceName: "stay-a", CredentialStamp: stamp})
	if err != nil {
		t.Fatalf("issue first: %v", err)
	}
	if _, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, DeviceName: "stay-b", CredentialStamp: stamp}); err != nil {
		t.Fatalf("issue second: %v", err)
	}
	firstID := sessionIDByDevice(t, owner, ctx, "stay-a")

	logs := captureLogs(t, owner)
	current, err := Current(firstID)
	if err != nil {
		t.Fatalf("construct current target: %v", err)
	}

	sentinel := errors.New("caller command failed after revocation")
	changedInTx := false
	err = runner.Run(ctx, func(sc *writetx.Scope) error {
		changed, err := store.Revoke(ctx, sc, current)
		changedInTx = changed
		if err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("rolled-back run: error %v, want the caller sentinel", err)
	}
	if !changedInTx {
		t.Fatal("revocation inside the aborted transaction reported no change; the deletion must have run pre-rollback")
	}
	if got := countSessions(t, owner, ctx); got != 2 {
		t.Fatalf("sessions after rollback = %d, want 2", got)
	}
	if _, err := store.Validate(ctx, first.Token); err != nil {
		t.Fatalf("revoked-then-rolled-back session: %v, want still valid", err)
	}
	if got := len(logs.effects); got != 0 {
		t.Fatalf("rollback dispatched %d effects, want 0", got)
	}

	// The panic path: writetx rolls back best-effort and re-panics; the
	// effect still never runs.
	func() {
		defer func() { _ = recover() }()
		_ = runner.Run(ctx, func(sc *writetx.Scope) error {
			if _, err := store.Revoke(ctx, sc, current); err != nil {
				return err
			}
			panic("caller panic after revocation")
		})
	}()
	if got := countSessions(t, owner, ctx); got != 2 {
		t.Fatalf("sessions after panicking run = %d, want 2", got)
	}
	if got := len(logs.effects); got != 0 {
		t.Fatalf("panicking run dispatched %d effects, want 0", got)
	}
	if got := countAuditRows(t, owner, ctx); got != 0 {
		t.Fatalf("audit rows after rolled-back revocations = %d, want 0", got)
	}
}

// Logical expiry precedes physical deletion: an expired session is already
// rejected by validation while its row still exists, and the sweep — the
// physical cleanup half — then deletes exactly the expired rows, keeps live
// sessions, writes no audit row, and is a clean no-op once nothing is
// expired.
func TestSweepDeletesOnlyExpiredSessionsAndWritesNoAudit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	owner, _, store, runner := storeHarness(t, ctx)
	userID, stamp := seedActiveUser(t, owner, ctx, "sweeper@nevix.test")

	live, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, DeviceName: "live", CredentialStamp: stamp})
	if err != nil {
		t.Fatalf("issue live session: %v", err)
	}
	stale, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, DeviceName: "stale", CredentialStamp: stamp})
	if err != nil {
		t.Fatalf("issue stale session: %v", err)
	}
	if _, err := owner.Exec(ctx, `UPDATE public.sessions SET expires_at = now() - interval '1 hour' WHERE device_name = 'stale'`); err != nil {
		t.Fatalf("expire stale session: %v", err)
	}

	// Before any cleanup: the expired token is already rejected while its row
	// is still durably present — expiry correctness never waits for the sweep.
	if _, err := store.Validate(ctx, stale.Token); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expired session before sweep: error %v, want ErrInvalid", err)
	}
	if got := countSessions(t, owner, ctx); got != 2 {
		t.Fatalf("sessions before sweep = %d, want 2", got)
	}

	if err := store.SweepExpired(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if got := countSessions(t, owner, ctx); got != 1 {
		t.Fatalf("sessions after sweep = %d, want 1 (only the live one)", got)
	}
	if _, err := store.Validate(ctx, live.Token); err != nil {
		t.Fatalf("live session after sweep: %v, want still valid", err)
	}
	if _, err := store.Validate(ctx, stale.Token); !errors.Is(err, ErrInvalid) {
		t.Fatalf("swept session: error %v, want ErrInvalid", err)
	}
	if got := countAuditRows(t, owner, ctx); got != 0 {
		t.Fatalf("audit rows after sweep = %d, want 0 (sweep writes no audit)", got)
	}

	// Nothing left to clean: the sweep is a clean no-op.
	if err := store.SweepExpired(ctx); err != nil {
		t.Fatalf("empty sweep: %v", err)
	}
	if _, err := store.Validate(ctx, live.Token); err != nil {
		t.Fatalf("live session after empty sweep: %v, want still valid", err)
	}
}

// Sweep failure is reported and never extends validity: with DELETE on
// sessions denied to the runtime credential — a forced infrastructure
// outage — the sweep answers an error, the expired session stays rejected at
// lookup and its row survives, and once the privilege is restored the next
// sweep cleans up.
func TestSweepFailureIsReportedAndDoesNotExtendValidity(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	owner, _, store, runner := storeHarness(t, ctx)
	userID, stamp := seedActiveUser(t, owner, ctx, "sweep-outage@nevix.test")

	stale, err := issue(t, runner, ctx, store, IssueInput{UserID: userID, DeviceName: "outage", CredentialStamp: stamp})
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	if _, err := owner.Exec(ctx, `UPDATE public.sessions SET expires_at = now() - interval '1 hour'`); err != nil {
		t.Fatalf("expire session: %v", err)
	}
	if _, err := store.Validate(ctx, stale.Token); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expired session before outage: error %v, want ErrInvalid", err)
	}

	// The outage: the runtime credential loses DELETE on sessions, so the
	// sweep's write transaction fails on permission; reads stay privileged
	// and validation keeps answering.
	if _, err := owner.Exec(ctx, `REVOKE DELETE ON public.sessions FROM identity_app`); err != nil {
		t.Fatalf("revoke delete for the outage: %v", err)
	}
	t.Cleanup(func() {
		if _, err := owner.Exec(context.Background(), `GRANT DELETE ON public.sessions TO identity_app`); err != nil {
			t.Errorf("restore delete privilege: %v", err)
		}
	})
	if err := store.SweepExpired(ctx); err == nil {
		t.Fatal("sweep under the outage succeeded, want the infrastructure failure reported")
	}
	if _, err := store.Validate(ctx, stale.Token); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expired session during outage: error %v, want ErrInvalid (cleanup outage never extends validity)", err)
	}
	if got := countSessions(t, owner, ctx); got != 1 {
		t.Fatalf("sessions during outage = %d, want 1 (the failed sweep deleted nothing)", got)
	}

	// The outage ends: the next sweep succeeds and reclaims the row.
	if _, err := owner.Exec(ctx, `GRANT DELETE ON public.sessions TO identity_app`); err != nil {
		t.Fatalf("restore delete privilege: %v", err)
	}
	if err := store.SweepExpired(ctx); err != nil {
		t.Fatalf("sweep after the outage: %v", err)
	}
	if got := countSessions(t, owner, ctx); got != 0 {
		t.Fatalf("sessions after the outage = %d, want 0", got)
	}
	if got := countAuditRows(t, owner, ctx); got != 0 {
		t.Fatalf("audit rows after the failed and successful sweeps = %d, want 0", got)
	}
}
