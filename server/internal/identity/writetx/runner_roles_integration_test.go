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
	"fmt"
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
		if os.Getenv("NEVIX_IDENTITY_INTEGRATION_REQUESTED") == "1" {
			t.Fatalf("identity integration was requested, but %s is not set; run ./scripts/test-identity-integration.sh from the repository root to start the supported harness", key)
		}
		t.Skipf("identity integration was not requested: %s is not set (run ./scripts/test-identity-integration.sh)", key)
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
	err := New(owner).Run(ctx, func(*Scope) error {
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
	err := New(assumed).Run(ctx, func(*Scope) error {
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
	if err := New(runtime).Run(ctx, func(sc *Scope) error {
		return sc.Tx().QueryRow(ctx, "SELECT session_user, current_user").Scan(&observedSession, &observedCurrent)
	}); err != nil {
		t.Fatalf("direct identity_app run failed: %v", err)
	}
	if observedSession != "identity_app" || observedCurrent != "identity_app" {
		t.Fatalf("callback observed session_user=%q current_user=%q, want identity_app", observedSession, observedCurrent)
	}
}

// effectTable is the throwaway owner-provisioned table the after-commit
// lifecycle evidence writes to: one row per test, dropped on cleanup. The
// owner connection provisions DDL; the runtime credential only needs the
// INSERT/SELECT grants it gets here.
func effectTable(t *testing.T, ctx context.Context, owner *pgxpool.Pool) string {
	t.Helper()
	name := fmt.Sprintf("writetx_effects_%d", time.Now().UnixNano())
	if _, err := owner.Exec(ctx, fmt.Sprintf(`
		CREATE TABLE public.%[1]s (id integer PRIMARY KEY);
		GRANT INSERT, SELECT ON public.%[1]s TO identity_app`, name)); err != nil {
		t.Fatalf("provision effect table: %v", err)
	}
	t.Cleanup(func() {
		_, _ = owner.Exec(context.WithoutCancel(ctx), fmt.Sprintf("DROP TABLE IF EXISTS public.%s", name))
	})
	return name
}

// rowCount reads the effect table over a fresh pool connection, so the read
// observes the committed database state, not this transaction.
func rowCount(t *testing.T, ctx context.Context, runtime *pgxpool.Pool, table string) int {
	t.Helper()
	var count int
	if err := runtime.QueryRow(ctx, fmt.Sprintf("SELECT count(*) FROM public.%s", table)).Scan(&count); err != nil {
		t.Fatalf("count effect rows: %v", err)
	}
	return count
}

// The after-commit contract against real PostgreSQL: a successful commit
// runs the registered effects exactly once, in registration order, and the
// first effect already observes the write as committed from another
// connection.
func TestRunExecutesAfterCommitEffectsAgainstCommittedState(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner := connectPool(t, ctx, requireEnv(t, "NEVIX_DATABASE_URL"), nil)
	runtime := connectPool(t, ctx, requireEnv(t, "NEVIX_IDENTITY_DATABASE_URL"), nil)
	table := effectTable(t, ctx, owner)

	var order []string
	commitsSeenByFirstEffect := -1
	if err := New(runtime).Run(ctx, func(sc *Scope) error {
		if _, err := sc.Tx().Exec(ctx, fmt.Sprintf("INSERT INTO public.%s (id) VALUES (1)", table)); err != nil {
			return fmt.Errorf("seed effect row: %w", err)
		}
		sc.AfterCommit(func() {
			if commitsSeenByFirstEffect < 0 {
				commitsSeenByFirstEffect = rowCount(t, ctx, runtime, table)
			}
			order = append(order, "first")
		})
		sc.AfterCommit(func() { order = append(order, "second") })
		return nil
	}); err != nil {
		t.Fatalf("successful run: %v", err)
	}
	if len(order) != 2 || order[0] != "first" || order[1] != "second" {
		t.Fatalf("effects ran as %v, want first,second each exactly once", order)
	}
	if commitsSeenByFirstEffect != 1 {
		t.Fatalf("first effect saw %d committed rows, want 1: effects must run after the commit", commitsSeenByFirstEffect)
	}
}

// A callback error against real PostgreSQL rolls the transaction back and
// runs no effect: neither the row nor the trigger survives the failure.
func TestRunSkipsAfterCommitEffectsOnCallbackErrorAgainstPostgreSQL(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner := connectPool(t, ctx, requireEnv(t, "NEVIX_DATABASE_URL"), nil)
	runtime := connectPool(t, ctx, requireEnv(t, "NEVIX_IDENTITY_DATABASE_URL"), nil)
	table := effectTable(t, ctx, owner)

	var ran int
	err := New(runtime).Run(ctx, func(sc *Scope) error {
		if _, err := sc.Tx().Exec(ctx, fmt.Sprintf("INSERT INTO public.%s (id) VALUES (1)", table)); err != nil {
			return fmt.Errorf("seed effect row: %w", err)
		}
		sc.AfterCommit(func() { ran++ })
		return errors.New("business failure")
	})
	if err == nil {
		t.Fatal("callback error was swallowed")
	}
	if ran != 0 {
		t.Fatalf("effects ran %d times on the rollback path", ran)
	}
	if got := rowCount(t, ctx, runtime, table); got != 0 {
		t.Fatalf("rolled-back run left %d rows, want 0", got)
	}
}

// Cancellation completing the callback prevents the commit against real
// PostgreSQL: the write rolls back and no effect runs.
func TestRunSkipsAfterCommitEffectsOnCancellationAgainstPostgreSQL(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner := connectPool(t, ctx, requireEnv(t, "NEVIX_DATABASE_URL"), nil)
	runtime := connectPool(t, ctx, requireEnv(t, "NEVIX_IDENTITY_DATABASE_URL"), nil)
	table := effectTable(t, ctx, owner)

	var ran int
	ctx2, cancelInCallback := context.WithCancel(ctx)
	err := New(runtime).Run(ctx2, func(sc *Scope) error {
		if _, err := sc.Tx().Exec(ctx2, fmt.Sprintf("INSERT INTO public.%s (id) VALUES (1)", table)); err != nil {
			return fmt.Errorf("seed effect row: %w", err)
		}
		sc.AfterCommit(func() { ran++ })
		// The callback swallows the cancellation, so only the runner's
		// completion check stands between the abandoned operation and the
		// commit — and the effects that would follow it.
		cancelInCallback()
		return nil
	})
	cancelInCallback()
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled run: %v, want the context error", err)
	}
	if ran != 0 {
		t.Fatalf("effects ran %d times on the cancellation path", ran)
	}
	if got := rowCount(t, ctx, runtime, table); got != 0 {
		t.Fatalf("canceled run left %d rows, want 0", got)
	}
}

// A callback panic against real PostgreSQL triggers the best-effort
// rollback and propagates; no effect runs on the panic path.
func TestRunSkipsAfterCommitEffectsOnCallbackPanicAgainstPostgreSQL(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	owner := connectPool(t, ctx, requireEnv(t, "NEVIX_DATABASE_URL"), nil)
	runtime := connectPool(t, ctx, requireEnv(t, "NEVIX_IDENTITY_DATABASE_URL"), nil)
	table := effectTable(t, ctx, owner)

	var ran int
	func() {
		defer func() {
			if r := recover(); r != "programming fault" {
				t.Fatalf("panic altered: %v", r)
			}
		}()
		_ = New(runtime).Run(ctx, func(sc *Scope) error {
			if _, err := sc.Tx().Exec(ctx, fmt.Sprintf("INSERT INTO public.%s (id) VALUES (1)", table)); err != nil {
				return fmt.Errorf("seed effect row: %w", err)
			}
			sc.AfterCommit(func() { ran++ })
			panic("programming fault")
		})
	}()
	if ran != 0 {
		t.Fatalf("effects ran %d times on the panic path", ran)
	}
	if got := rowCount(t, ctx, runtime, table); got != 0 {
		t.Fatalf("panicked run left %d rows, want 0", got)
	}
}
