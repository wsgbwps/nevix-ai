// Real-PostgreSQL role evidence for the Write Transaction Module, opt-in like
// the integrationtest suite: the harness (scripts/test-mail-smoke.sh) exports
// NEVIX_DATABASE_URL (the owner credential, used only to build deliberately
// wrong runner inputs) and NEVIX_IDENTITY_DATABASE_URL (the identity_app
// runtime credential the runner must accept). Without the harness these tests
// skip; the runner's transaction contract is proven separately by the narrow
// double in writetx_test.go, and Module construction by
// integrationtest/startup_identity_test.go.
package writetx

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func requireEnv(t *testing.T, key string) string {
	t.Helper()
	value := os.Getenv(key)
	if value == "" {
		t.Skipf("%s not set; harness scripts/test-mail-smoke.sh exports it", key)
	}
	return value
}

func connectPool(t *testing.T, ctx context.Context, url string, configure func(*pgxpool.Config)) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("parse database url: %v", err)
	}
	if configure != nil {
		configure(cfg)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// An owner credential is rejected per transaction even though it is a member
// of identity_app: the write boundary cannot be satisfied by a role switch.
func TestRunRejectsOwnerCredential(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner := connectPool(t, ctx, requireEnv(t, "NEVIX_DATABASE_URL"), nil)

	var ownerCanAssume bool
	if err := owner.QueryRow(ctx, `SELECT pg_has_role(session_user, 'identity_app', 'MEMBER')`).Scan(&ownerCanAssume); err != nil {
		t.Fatalf("read owner role membership: %v", err)
	}
	if !ownerCanAssume {
		t.Fatal("owner cannot assume identity_app; the rejection evidence is meaningless")
	}

	invoked := false
	err := New(owner).Run(ctx, func(pgx.Tx) error {
		invoked = true
		return nil
	})
	if !errors.Is(err, ErrUnexpectedDatabaseIdentity) {
		t.Fatalf("owner credential accepted or wrong error: %v", err)
	}
	if invoked {
		t.Fatal("business callback ran under the owner credential")
	}
}

// A pool that downgrades to identity_app on every connection presents
// current_user = identity_app while session_user stays the authenticated
// owner; the per-transaction check must reject it exactly like construction
// does.
func TestRunRejectsAssumedIdentityAppRole(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	assumed := connectPool(t, ctx, requireEnv(t, "NEVIX_DATABASE_URL"), func(cfg *pgxpool.Config) {
		cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
			_, err := conn.Exec(ctx, "SET ROLE identity_app")
			return err
		}
	})

	var sessionUser, currentUser string
	if err := assumed.QueryRow(ctx, "SELECT session_user, current_user").Scan(&sessionUser, &currentUser); err != nil {
		t.Fatalf("observe assumed-role pool identity: %v", err)
	}
	if sessionUser == "identity_app" || currentUser != "identity_app" {
		t.Fatalf("assumed-role pool presents session_user=%q current_user=%q, want owner session with identity_app execution", sessionUser, currentUser)
	}

	invoked := false
	err := New(assumed).Run(ctx, func(pgx.Tx) error {
		invoked = true
		return nil
	})
	if !errors.Is(err, ErrUnexpectedDatabaseIdentity) {
		t.Fatalf("assumed-role pool accepted or wrong error: %v", err)
	}
	if invoked {
		t.Fatal("business callback ran under an assumed identity_app role")
	}
}

// The runtime credential authenticates directly as identity_app, so the
// callback runs and observes the same identity inside the transaction it
// uses for its writes.
func TestRunAcceptsDirectIdentityAppCredential(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	runtime := connectPool(t, ctx, requireEnv(t, "NEVIX_IDENTITY_DATABASE_URL"), nil)

	var observedSession, observedCurrent string
	if err := New(runtime).Run(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, "SELECT session_user, current_user").Scan(&observedSession, &observedCurrent)
	}); err != nil {
		t.Fatalf("direct identity_app run failed: %v", err)
	}
	if observedSession != "identity_app" || observedCurrent != "identity_app" {
		t.Fatalf("callback observed session_user=%q current_user=%q, want identity_app", observedSession, observedCurrent)
	}
}
