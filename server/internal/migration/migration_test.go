// Unit tests for the embedded migration set: files are discoverable, follow
// the <version>_<name>.sql naming discipline, and are up-only Goose SQL (an
// Up section, never a Down section — ADR-0013). The apply path is proven
// against PostgreSQL by migration_integration_test.go.
package migration

import (
	"io/fs"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// embeddedSQL returns every embedded migration path in version order.
func embeddedSQL(t *testing.T) []string {
	t.Helper()
	entries, err := fs.Glob(migrationFS, "migrations/*.sql")
	if err != nil {
		t.Fatalf("glob embedded migrations: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("no embedded migrations found; the baseline must be embedded")
	}
	return entries
}

var migrationName = regexp.MustCompile(`^migrations/([0-9]+)_[a-z0-9_]+\.sql$`)

func TestEmbeddedMigrationsFollowNamingDiscipline(t *testing.T) {
	seen := map[int64]bool{}
	for _, entry := range embeddedSQL(t) {
		match := migrationName.FindStringSubmatch(entry)
		if match == nil {
			t.Fatalf("%q must be named <version>_<name>.sql with a positive numeric version", entry)
		}
		version, err := strconv.ParseInt(match[1], 10, 64)
		if err != nil || version < 1 {
			t.Fatalf("%q has a non-numeric or non-positive version %q", entry, match[1])
		}
		if seen[version] {
			t.Fatalf("duplicate migration version %d", version)
		}
		seen[version] = true
	}
}

func TestEmbeddedMigrationsAreUpOnlyGooseSQL(t *testing.T) {
	if len(embeddedSQL(t)) == 0 {
		t.Fatal("no embedded migrations found")
	}
	for _, entry := range embeddedSQL(t) {
		sqlBytes, err := migrationFS.ReadFile(entry)
		if err != nil {
			t.Fatalf("read %q: %v", entry, err)
		}
		sql := string(sqlBytes)
		if !strings.Contains(sql, "-- +goose Up") {
			t.Fatalf("%q has no '-- +goose Up' annotation; Goose cannot run it", entry)
		}
		if strings.Contains(sql, "-- +goose Down") {
			t.Fatalf("%q declares a Down section; migrations are up-only (ADR-0013)", entry)
		}
	}
}

func TestBaselineCreatesUserSystemTables(t *testing.T) {
	entries := embeddedSQL(t)
	baseline, err := fs.ReadFile(migrationFS, entries[0])
	if err != nil {
		t.Fatalf("read baseline %q: %v", entries[0], err)
	}
	sql := string(baseline)
	for _, table := range []string{"CREATE TABLE public.users", "CREATE TABLE public.sessions", "CREATE TABLE public.audit_logs"} {
		if !strings.Contains(sql, table) {
			t.Fatalf("baseline SQL does not create %q", table)
		}
	}
	// The dropped multi-organization world must not come back: no RLS, no
	// organization dimension, no legacy table creation (ADR-0015). The
	// teardown DROP statements are the required drop-rebuild, not a recreation.
	for _, forbidden := range []string{"ROW LEVEL SECURITY", "organization_id", "CREATE TABLE public.outbox_messages", "CREATE TABLE public.invitations", "CREATE TABLE public.memberships", "CREATE TABLE public.organizations", "CREATE TABLE public.profiles", "CREATE TABLE public.verification_codes"} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("baseline SQL references %q, which the new baseline must not recreate", forbidden)
		}
	}
}
