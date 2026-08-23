// The integration-suite harness: environment gating (requireEnv), schema
// migrations through the production runner, the two database credentials with
// their distinct identities, and the Module lifecycle helpers. fixturePool is
// the owner credential: it applies fixtures and makes authoritative
// assertions, and is never handed to the identity Module except where a test
// explicitly proves such a credential is rejected. runtimePool authenticates
// directly as identity_app — the production runtime credential — and is the
// only pool Module construction sees.
package integrationtest

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/identity"
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

var (
	migrateOnce     sync.Once
	migrateFirstErr error
)

// applyMigrations brings the harness database to the newest embedded version
// exactly as server startup does, once per test binary.
func applyMigrations(t *testing.T, ctx context.Context, ownerURL string) {
	t.Helper()
	migrateOnce.Do(func() {
		_, migrateFirstErr = migration.Apply(ctx, ownerURL)
	})
	if migrateFirstErr != nil {
		t.Fatalf("apply migrations through the production runner: %v", migrateFirstErr)
	}
}

// harness wires one test to the running local stack, or skips.
type harness struct {
	ownerURL    string
	fixturePool *pgxpool.Pool
	runtimePool *pgxpool.Pool
	cfg         identity.Config
}

func newHarness(t *testing.T, ctx context.Context) *harness {
	t.Helper()
	ownerURL := requireEnv(t, "NEVIX_DATABASE_URL")
	runtimeDatabaseURL := requireEnv(t, "NEVIX_IDENTITY_DATABASE_URL")
	for _, key := range []string{"NEVIX_CORS_ALLOWED_ORIGINS", "NEVIX_ADMIN_EMAIL", "NEVIX_ADMIN_INITIAL_PASSWORD"} {
		requireEnv(t, key)
	}
	// The harness assembles the Module through the same seam as the
	// composition root: LoadConfig + NewModule + Register/RunWorkers.
	cfg, err := identity.LoadConfig(func(key string) string { return os.Getenv("NEVIX_" + key) })
	if err != nil {
		t.Fatalf("load identity module config from NEVIX_-prefixed environment: %v", err)
	}
	applyMigrations(t, ctx, ownerURL)

	fixturePool, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner fixture database: %v", err)
	}
	t.Cleanup(fixturePool.Close)
	runtimePool, err := pgxpool.New(ctx, runtimeDatabaseURL)
	if err != nil {
		t.Fatalf("connect identity_app runtime database: %v", err)
	}
	t.Cleanup(runtimePool.Close)
	return &harness{
		ownerURL:    ownerURL,
		fixturePool: fixturePool,
		runtimePool: runtimePool,
		cfg:         cfg,
	}
}

// resetUserState gives one test exclusive user-system state: the owner
// credential truncates users (sessions follow by foreign key) and the audit
// log together.
func (h *harness) resetUserState(t *testing.T) {
	t.Helper()
	if _, err := h.fixturePool.Exec(context.Background(), `TRUNCATE public.audit_logs, public.sessions, public.join_codes, public.users`); err != nil {
		t.Fatalf("truncate user-system tables: %v", err)
	}
}

// countUsers asserts state through the owner credential.
func (h *harness) countUsers(t *testing.T) int {
	t.Helper()
	var count int
	if err := h.fixturePool.QueryRow(context.Background(), `SELECT count(*) FROM public.users`).Scan(&count); err != nil {
		t.Fatalf("count users: %v", err)
	}
	return count
}

// auditActions returns the audit rows' actions in insert order.
func (h *harness) auditActions(t *testing.T) []string {
	t.Helper()
	rows, err := h.fixturePool.Query(context.Background(), `SELECT action FROM public.audit_logs ORDER BY created_at, id`)
	if err != nil {
		t.Fatalf("read audit actions: %v", err)
	}
	defer rows.Close()
	actions := []string{}
	for rows.Next() {
		var action string
		if err := rows.Scan(&action); err != nil {
			t.Fatalf("scan audit action: %v", err)
		}
		actions = append(actions, action)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate audit actions: %v", err)
	}
	return actions
}

// startWorkers runs one Module's background workers for the duration of the
// test and returns a stop function that cancels them and asserts they exit
// gracefully.
func (h *harness) startWorkers(t *testing.T, m *identity.Module) (stop func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- m.RunWorkers(ctx) }()
	var once sync.Once
	stop = func() {
		once.Do(func() {
			cancel()
			select {
			case err := <-done:
				if err != nil {
					t.Errorf("worker did not shut down cleanly: %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Errorf("worker did not stop within 10s of context cancellation")
			}
		})
	}
	t.Cleanup(stop)
	return stop
}
