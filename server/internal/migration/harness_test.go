// Integration-harness support for the migration package (mirrors identity's
// harness_test.go placement rule): environment gating on the harness DSN,
// private scratch-database provisioning, and assertion connections. Scenario
// tests live in migration_integration_test.go.
package migration

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
)

// requireOwnerURL gates the suite on the harness environment: plain
// `go test ./...` skips so it stays green with no stack running, while
// NEVIX_IDENTITY_INTEGRATION_REQUESTED=1 (set by the dedicated harness entry)
// makes a missing value fatal.
func requireOwnerURL(t *testing.T) string {
	t.Helper()
	value := os.Getenv("NEVIX_DATABASE_URL")
	if value == "" {
		if os.Getenv("NEVIX_IDENTITY_INTEGRATION_REQUESTED") == "1" {
			t.Fatalf("identity integration was requested, but NEVIX_DATABASE_URL is not set; run ./scripts/test-identity-integration.sh from the repository root to start the supported harness")
		}
		t.Skipf("identity integration was not requested: NEVIX_DATABASE_URL is not set (run ./scripts/test-identity-integration.sh)")
	}
	return value
}

// scratchDatabase provisions a private empty database inside the harness
// cluster and returns its DSN. Tests drop and recreate it, so scenarios start
// from a genuinely empty PostgreSQL, exactly like a fresh on-prem deployment.
func scratchDatabase(t *testing.T, ctx context.Context, ownerURL, name string) string {
	t.Helper()
	scratchURL := strings.Replace(ownerURL, "/postgres?", "/"+name+"?", 1)
	admin, err := sql.Open("pgx", ownerURL)
	if err != nil {
		t.Fatalf("open admin connection: %v", err)
	}
	// Close runs after the drop below: t.Cleanup is LIFO, and the drop
	// cleanup is registered last.
	t.Cleanup(func() { admin.Close() })
	if _, err := admin.ExecContext(ctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
		t.Fatalf("reset scratch database: %v", err)
	}
	if _, err := admin.ExecContext(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create scratch database: %v", err)
	}
	t.Cleanup(func() {
		if _, err := admin.ExecContext(context.WithoutCancel(ctx), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
			t.Fatalf("drop scratch database: %v", err)
		}
	})
	return scratchURL
}

// openDB opens an assertion connection over the pgx stdlib driver.
func openDB(t *testing.T, ctx context.Context, url string) *sql.DB {
	t.Helper()
	db, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatalf("open %s: %v", url, err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("ping %s: %v", url, err)
	}
	return db
}
