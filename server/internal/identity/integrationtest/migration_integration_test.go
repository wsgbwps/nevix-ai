// Schema-baseline evidence (issue #100): the migrations applied by the
// production runner create the single-tenant user system — no RLS, no
// organization dimension, no identity schema — with the least-privilege
// identity_app grants, and re-apply is a no-op (Goose ledger, issue #108).
// Catalog inspection runs on the owner credential.
package integrationtest

import (
	"context"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/migration"
)

func TestReapplyingMigrationsIsANoOp(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	applied, err := migration.Apply(ctx, h.ownerURL)
	if err != nil {
		t.Fatalf("re-apply migrations: %v", err)
	}
	if len(applied) != 0 {
		t.Fatalf("re-apply ran %d migrations (%v), want 0: versions must be recorded exactly once", len(applied), applied)
	}
}

func TestBaselineSchemaIsTheSingleTenantUserSystem(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	// The new baseline tables exist; the dropped world does not come back.
	for _, table := range []string{"users", "sessions", "audit_logs"} {
		var exists bool
		if err := h.fixturePool.QueryRow(ctx,
			`SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = $1)`, table,
		).Scan(&exists); err != nil {
			t.Fatalf("inspect table %s: %v", table, err)
		}
		if !exists {
			t.Fatalf("baseline table public.%s does not exist", table)
		}
	}
	for _, table := range []string{"organizations", "memberships", "invitations", "verification_codes", "outbox_messages", "profiles"} {
		var exists bool
		if err := h.fixturePool.QueryRow(ctx,
			`SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = $1)`, table,
		).Scan(&exists); err != nil {
			t.Fatalf("inspect table %s: %v", table, err)
		}
		if exists {
			t.Fatalf("legacy table public.%s still exists; the drop-rebuild baseline must replace it", table)
		}
	}
	var identitySchemaExists bool
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'identity')`,
	).Scan(&identitySchemaExists); err != nil {
		t.Fatalf("inspect identity schema: %v", err)
	}
	if identitySchemaExists {
		t.Fatal("the identity schema still exists; the baseline must cancel it")
	}

	// No RLS anywhere: with no client-side database access there is no policy
	// subject (ADR-0015).
	var relrowsecurity int
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND rowsecurity`,
	).Scan(&relrowsecurity); err != nil {
		t.Fatalf("count RLS-enabled tables: %v", err)
	}
	if relrowsecurity != 0 {
		t.Fatalf("%d public tables have RLS enabled; the baseline removes it entirely", relrowsecurity)
	}
}

func TestIdentityAppGrantsMatchTheLeastPrivilegeContract(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)

	// has_table_privilege proves the effective grant surface behaviorally.
	for table, want := range map[string][]string{
		"public.users":      {"SELECT", "INSERT", "UPDATE"},
		"public.sessions":   {"SELECT", "INSERT", "UPDATE", "DELETE"},
		"public.audit_logs": {"SELECT", "INSERT", "DELETE"},
	} {
		for _, privilege := range []string{"SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"} {
			var has bool
			if err := h.fixturePool.QueryRow(ctx,
				`SELECT has_table_privilege('identity_app', $1, $2)`, table, privilege,
			).Scan(&has); err != nil {
				t.Fatalf("read privilege %s on %s: %v", privilege, table, err)
			}
			wantHas := false
			for _, allowed := range want {
				if privilege == allowed {
					wantHas = true
				}
			}
			if has != wantHas {
				t.Fatalf("identity_app %s on %s = %v, want %v", privilege, table, has, wantHas)
			}
		}
	}

	// The immutability seam (ADR-0009): no UPDATE on audit rows, by grant.
	var canUpdateAudit bool
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT has_table_privilege('identity_app', 'public.audit_logs', 'UPDATE')`,
	).Scan(&canUpdateAudit); err != nil {
		t.Fatalf("read audit UPDATE grant: %v", err)
	}
	if canUpdateAudit {
		t.Fatal("identity_app holds UPDATE on audit_logs; immutability would be unenforceable")
	}

	// No DDL: the application role cannot create objects in public.
	var canCreate bool
	if err := h.fixturePool.QueryRow(ctx,
		`SELECT has_schema_privilege('identity_app', 'public', 'CREATE')`,
	).Scan(&canCreate); err != nil {
		t.Fatalf("read identity_app schema privilege: %v", err)
	}
	if canCreate {
		t.Fatal("identity_app may create objects in the public schema; DDL belongs to the migration credential")
	}
}
