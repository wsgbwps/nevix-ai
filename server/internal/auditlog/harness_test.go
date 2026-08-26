// Test-support helpers for the shared Audit Append seam's real-PostgreSQL
// evidence: environment gating, schema migrations through the production
// runner, the two harness credentials (owner for fixtures, grant toggles,
// and assertions; identity_app runtime for the transactions that call
// Append), and the shared assertion fixtures. Scenario tests live in
// append_integration_test.go.
package auditlog

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/migration"
)

// requireEnv returns one harness-provided environment value, or skips/fails
// per the integration request flag: plain `go test ./...` skips so it stays
// green with no stack running, while NEVIX_IDENTITY_INTEGRATION_REQUESTED=1
// (set by the dedicated harness entry) makes a missing value fatal.
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

// connectPool connects one harness credential and closes it with the test.
func connectPool(t *testing.T, ctx context.Context, url string) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

var (
	migrateOnce     sync.Once
	migrateFirstErr error
)

// applyMigrations brings the harness database to the newest embedded version
// exactly as server startup does, once per test binary, so the audit table
// and its least-privilege grants are the production shapes.
func applyMigrations(t *testing.T, ctx context.Context, ownerURL string) {
	t.Helper()
	migrateOnce.Do(func() {
		_, migrateFirstErr = migration.Apply(ctx, ownerURL)
	})
	if migrateFirstErr != nil {
		t.Fatalf("apply migrations through the production runner: %v", migrateFirstErr)
	}
}

// appendHarness gives one test exclusive user-system state over the two
// harness credentials.
type appendHarness struct {
	owner   *pgxpool.Pool
	runtime *pgxpool.Pool
}

func newAppendHarness(t *testing.T) *appendHarness {
	t.Helper()
	ctx := context.Background()
	ownerURL := requireEnv(t, "NEVIX_DATABASE_URL")
	runtimeURL := requireEnv(t, "NEVIX_IDENTITY_DATABASE_URL")
	applyMigrations(t, ctx, ownerURL)
	h := &appendHarness{
		owner:   connectPool(t, ctx, ownerURL),
		runtime: connectPool(t, ctx, runtimeURL),
	}
	if _, err := h.owner.Exec(ctx, `TRUNCATE public.audit_logs, public.sessions, public.join_codes, public.users`); err != nil {
		t.Fatalf("truncate user-system tables: %v", err)
	}
	return h
}

// seedUser inserts one user row — the caller-side business fact the scenario
// tests commit or roll back alongside the audit row — inside the given
// transaction and returns its id.
func seedUser(ctx context.Context, tx pgx.Tx, seq int) (string, error) {
	var id string
	if err := tx.QueryRow(ctx,
		`INSERT INTO public.users (email, password_hash, display_name, role, status)
		 VALUES ($1, 'x', $2, 'member', 'active') RETURNING id`,
		fmt.Sprintf("append-%d@example.test", seq), fmt.Sprintf("Append Subject %d", seq),
	).Scan(&id); err != nil {
		return "", fmt.Errorf("seed user: %w", err)
	}
	return id, nil
}

// auditRowCount asserts committed audit rows through the owner credential.
func (h *appendHarness) auditRowCount(t *testing.T, ctx context.Context) int {
	t.Helper()
	var count int
	if err := h.owner.QueryRow(ctx, `SELECT count(*) FROM public.audit_logs`).Scan(&count); err != nil {
		t.Fatalf("count audit rows: %v", err)
	}
	return count
}

// userCount asserts committed user rows through the owner credential.
func (h *appendHarness) userCount(t *testing.T, ctx context.Context) int {
	t.Helper()
	var count int
	if err := h.owner.QueryRow(ctx, `SELECT count(*) FROM public.users`).Scan(&count); err != nil {
		t.Fatalf("count users: %v", err)
	}
	return count
}
