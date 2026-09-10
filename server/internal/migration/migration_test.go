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

func TestObjectStorageMigrationOwnsSingletonRevisionAndLeastPrivilege(t *testing.T) {
	sqlBytes, err := migrationFS.ReadFile("migrations/0015_object_storage_connections.sql")
	if err != nil {
		t.Fatalf("read object storage migration: %v", err)
	}
	sql := string(sqlBytes)
	for _, required := range []string{
		"CREATE SEQUENCE public.object_storage_connection_revision_seq",
		"CREATE TABLE public.object_storage_connections",
		"WHERE terminated_at IS NULL",
		"nextval('public.object_storage_connection_revision_seq'::regclass)",
		"GRANT SELECT, INSERT, UPDATE ON public.object_storage_connections TO identity_app",
		"GRANT USAGE ON SEQUENCE public.object_storage_connection_revision_seq TO identity_app",
		"object_storage_connection.create",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("object storage migration missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"GRANT DELETE ON public.object_storage_connections",
		"GRANT ALL",
	} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("object storage migration grants forbidden capability %q", forbidden)
		}
	}
}

func TestObjectStorageMaintenanceMigrationOwnsFreezeAndExactActions(t *testing.T) {
	sqlBytes, err := migrationFS.ReadFile("migrations/0016_object_storage_connection_maintenance.sql")
	if err != nil {
		t.Fatalf("read object storage maintenance migration: %v", err)
	}
	sql := string(sqlBytes)
	for _, required := range []string{
		"location_frozen_at",
		"temporarily_unavailable",
		"object_storage_connection.replace",
		"object_storage_connection.rotate",
		"object_storage_connection.delete",
		"object_storage_connection.recover",
		"creation_reference_materials",
		"creation_media_assets",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("object storage maintenance migration missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"GRANT DELETE ON public.object_storage_connections",
		"GRANT ALL",
		"CREATE TABLE public.reference_material_uploads",
		"CREATE TABLE public.provider_transfer_objects",
	} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("object storage maintenance migration contains forbidden expansion %q", forbidden)
		}
	}
}

func TestReferenceMaterialUploadResilienceMigrationOwnsLeaseAndCleanupFacts(t *testing.T) {
	sqlBytes, err := migrationFS.ReadFile("migrations/0018_reference_material_upload_resilience.sql")
	if err != nil {
		t.Fatalf("read reference material upload resilience migration: %v", err)
	}
	sql := string(sqlBytes)
	for _, required := range []string{
		"verification_token",
		"verification_lease_until",
		"cleanup_attempt_count",
		"cleanup_next_attempt_at",
		"cleanup_confirmed_at",
		"status IN ('pending', 'verifying', 'finalized', 'terminal')",
		"WHERE status IN ('terminal', 'finalized') AND cleanup_confirmed_at IS NULL",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("reference material upload resilience migration missing %q", required)
		}
	}
}

func TestGenerationTransferBindingMigrationOwnsNarrowStorageFence(t *testing.T) {
	sqlBytes, err := migrationFS.ReadFile("migrations/0019_generation_transfer_storage_binding.sql")
	if err != nil {
		t.Fatalf("read generation transfer storage binding migration: %v", err)
	}
	sql := string(sqlBytes)
	for _, required := range []string{
		"object_storage_connection_id",
		"REFERENCES public.object_storage_connections (id)",
		"WHERE object_storage_connection_id IS NOT NULL AND terminal_at IS NULL",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("generation transfer storage binding migration missing %q", required)
		}
	}
}
