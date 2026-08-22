// Unit tests for the embedded migration set: naming discipline, version
// ordering, uniqueness, and non-empty SQL. The real apply path is proven
// against PostgreSQL by the integrationtest suite.
package migration

import (
	"strings"
	"testing"
)

func TestAvailableReturnsVersionOrderedMigrations(t *testing.T) {
	migrations, err := Available()
	if err != nil {
		t.Fatalf("Available: %v", err)
	}
	if len(migrations) == 0 {
		t.Fatal("Available returned no migrations; the baseline must be embedded")
	}
	for index := 1; index < len(migrations); index++ {
		if migrations[index].Version <= migrations[index-1].Version {
			t.Fatalf("migrations out of order at %d: %d then %d", index, migrations[index-1].Version, migrations[index].Version)
		}
	}
	if migrations[0].Version != 1 {
		t.Fatalf("first migration version = %d, want 1 (baseline must start the up-only history)", migrations[0].Version)
	}
	for _, m := range migrations {
		if strings.TrimSpace(m.SQL) == "" {
			t.Fatalf("migration %d (%s) has empty SQL", m.Version, m.Name)
		}
		if m.Name == "" {
			t.Fatalf("migration %d has an empty name", m.Version)
		}
	}
}

func TestBaselineCreatesUserSystemTables(t *testing.T) {
	migrations, err := Available()
	if err != nil {
		t.Fatalf("Available: %v", err)
	}
	baseline := migrations[0].SQL
	for _, table := range []string{"CREATE TABLE public.users", "CREATE TABLE public.sessions", "CREATE TABLE public.audit_logs"} {
		if !strings.Contains(baseline, table) {
			t.Fatalf("baseline SQL does not create %q", table)
		}
	}
	// The dropped multi-organization world must not come back: no RLS, no
	// organization dimension, no legacy table creation (ADR-0015). The
	// teardown DROP statements are the required drop-rebuild, not a recreation.
	for _, forbidden := range []string{"ROW LEVEL SECURITY", "organization_id", "CREATE TABLE public.outbox_messages", "CREATE TABLE public.invitations", "CREATE TABLE public.memberships", "CREATE TABLE public.organizations", "CREATE TABLE public.profiles", "CREATE TABLE public.verification_codes"} {
		if strings.Contains(baseline, forbidden) {
			t.Fatalf("baseline SQL references %q, which the new baseline must not recreate", forbidden)
		}
	}
}
