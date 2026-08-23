// Real-PostgreSQL evidence for the session-issuance revalidation (issue
// #102 review): the credential check Login performs before its transaction
// must be re-proven under the account's row lock inside issueSession, so a
// reset-password or disable that commits while a login is in flight can
// never leave a stale-credential session behind. The interleaving is driven
// deterministically by mutating the account between the pre-transaction read
// and the issuance call. Opt-in like the writetx suite: the harness
// (scripts/test-identity-integration.sh) exports NEVIX_DATABASE_URL (owner)
// and NEVIX_IDENTITY_DATABASE_URL (the identity_app runtime credential);
// without the harness these tests skip.
package auth

import (
	"context"
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

// raceHarness owns the two credentials and a service built exactly as the
// Module builds one, with the schema already at the newest version.
func raceHarness(t *testing.T, ctx context.Context) (owner, runtime *pgxpool.Pool, service *Service) {
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
	return owner, runtime, NewService(runtime, writetx.New(runtime))
}

func countSessions(t *testing.T, owner *pgxpool.Pool, ctx context.Context) int {
	t.Helper()
	var count int
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM public.sessions`).Scan(&count); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	return count
}

// A reset-password committing between Login's verification and the issuance
// transaction must void the in-flight login: the recheck under the row lock
// sees the replaced hash and answers like any wrong password.
func TestIssueSessionRejectsStaleCredentialsAfterReset(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	owner, _, service := raceHarness(t, ctx)

	hash, err := bcrypt.GenerateFromPassword([]byte("old-password-1"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	if _, err := owner.Exec(ctx,
		`INSERT INTO public.users (email, password_hash, display_name, role, status, must_change_password)
		 VALUES ('racer@nevix.test', $1, 'racer@nevix.test', 'member', 'active', false)`, string(hash),
	); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	// The pre-transaction read Login would perform.
	user, err := service.loadUserByEmail(ctx, "racer@nevix.test")
	if err != nil {
		t.Fatalf("load user: %v", err)
	}

	// The reset commits inside the verification-to-issuance window.
	if _, err := owner.Exec(ctx,
		`UPDATE public.users SET password_hash = 'replacement-hash' WHERE email = 'racer@nevix.test'`,
	); err != nil {
		t.Fatalf("replace password hash: %v", err)
	}

	_, tokenHash, err := newSessionToken()
	if err != nil {
		t.Fatalf("mint token: %v", err)
	}
	if _, err := service.issueSession(ctx, user, tokenHash, "race-window"); !errors.Is(err, errInvalidCredentials) {
		t.Fatalf("issuance after reset: error %v, want errInvalidCredentials", err)
	}
	if got := countSessions(t, owner, ctx); got != 0 {
		t.Fatalf("sessions after refused issuance = %d, want 0", got)
	}

	// The same lock recheck refuses a disable that landed in the window:
	// issuing a session for a just-disabled account is wrong even though the
	// next lookup would reject it.
	if _, err := owner.Exec(ctx,
		`UPDATE public.users SET status = 'disabled' WHERE email = 'racer@nevix.test'`,
	); err != nil {
		t.Fatalf("disable user: %v", err)
	}
	_, tokenHash, err = newSessionToken()
	if err != nil {
		t.Fatalf("mint second token: %v", err)
	}
	if _, err := service.issueSession(ctx, user, tokenHash, "race-window"); !errors.Is(err, errAccountDisabled) {
		t.Fatalf("issuance after disable: error %v, want errAccountDisabled", err)
	}
	if got := countSessions(t, owner, ctx); got != 0 {
		t.Fatalf("sessions after second refused issuance = %d, want 0", got)
	}

	// Control: an account whose row is unchanged still issues normally.
	if _, err := owner.Exec(ctx,
		`UPDATE public.users SET status = 'active' WHERE email = 'racer@nevix.test'`,
	); err != nil {
		t.Fatalf("re-enable user: %v", err)
	}
	loaded, err := service.loadUserByEmail(ctx, "racer@nevix.test")
	if err != nil {
		t.Fatalf("reload enabled user: %v", err)
	}
	_, controlHash, err := newSessionToken()
	if err != nil {
		t.Fatalf("mint control token: %v", err)
	}
	if _, err := service.issueSession(ctx, loaded, controlHash, "control"); err != nil {
		t.Fatalf("control issuance: %v", err)
	}
	if got := countSessions(t, owner, ctx); got != 1 {
		t.Fatalf("sessions after control issuance = %d, want 1", got)
	}
}
