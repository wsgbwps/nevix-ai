// The drop-rebuild promise against a legacy database: the baseline migration
// tears the Supabase-era world down (identity schema, organization tables,
// RLS) and creates the user system in its place. The proof runs on a private
// scratch database inside the harness cluster so the shared suite database is
// untouched.
package integrationtest

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/nevix-ai/server/internal/migration"
)

// scratchDatabaseURL derives a private-database DSN from the harness owner
// URL (both harness DSNs address the default `postgres` database).
func scratchDatabaseURL(ownerURL string) string {
	return strings.Replace(ownerURL, "/postgres?", "/nevix_legacy_upgrade_test?", 1)
}

func TestBaselineDropsTheLegacyWorldAndRebuilds(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	h := newHarness(t, ctx)
	scratchURL := scratchDatabaseURL(h.ownerURL)

	if _, err := h.fixturePool.Exec(ctx, `DROP DATABASE IF EXISTS nevix_legacy_upgrade_test`); err != nil {
		t.Fatalf("reset scratch database: %v", err)
	}
	if _, err := h.fixturePool.Exec(ctx, `CREATE DATABASE nevix_legacy_upgrade_test`); err != nil {
		t.Fatalf("create scratch database: %v", err)
	}
	t.Cleanup(func() {
		if _, err := h.fixturePool.Exec(context.WithoutCancel(ctx), `DROP DATABASE nevix_legacy_upgrade_test WITH (FORCE)`); err != nil {
			t.Fatalf("drop scratch database: %v", err)
		}
	})

	conn, err := pgx.Connect(ctx, scratchURL)
	if err != nil {
		t.Fatalf("connect scratch database: %v", err)
	}
	legacy := `
		CREATE SCHEMA identity;
		CREATE TABLE identity.verification_codes (id uuid PRIMARY KEY);
		CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text NOT NULL);
		CREATE TABLE public.memberships (
			id uuid PRIMARY KEY,
			organization_id uuid NOT NULL REFERENCES public.organizations(id),
			user_id uuid NOT NULL,
			role text NOT NULL,
			status text NOT NULL
		);
		ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
		CREATE TABLE public.invitations (id uuid PRIMARY KEY, organization_id uuid NOT NULL, email text NOT NULL);
		CREATE TABLE public.outbox_messages (id uuid PRIMARY KEY, payload jsonb NOT NULL);
		CREATE TABLE public.audit_logs (
			id uuid PRIMARY KEY,
			organization_id uuid NOT NULL,
			actor_user_id uuid NOT NULL,
			actor_display_name text NOT NULL,
			action text NOT NULL,
			metadata jsonb NOT NULL DEFAULT '{}'
		);`
	if _, err := conn.Exec(ctx, legacy); err != nil {
		t.Fatalf("seed legacy schema: %v", err)
	}
	if err := conn.Close(ctx); err != nil {
		t.Fatalf("close legacy connection: %v", err)
	}

	applied, err := migration.Apply(ctx, scratchURL)
	if err != nil {
		t.Fatalf("apply baseline over legacy schema: %v", err)
	}
	if len(applied) != 2 {
		t.Fatalf("applied %d migrations on the legacy scratch database, want the 2 embedded ones", len(applied))
	}

	conn, err = pgx.Connect(ctx, scratchURL)
	if err != nil {
		t.Fatalf("reconnect scratch database: %v", err)
	}
	t.Cleanup(func() { conn.Close(context.WithoutCancel(ctx)) })

	var legacyLeft int
	if err := conn.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM pg_namespace WHERE nspname = 'identity') +
			(SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY (ARRAY['organizations','memberships','invitations','outbox_messages','profiles','verification_codes'])) +
			(SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND rowsecurity)`).Scan(&legacyLeft); err != nil {
		t.Fatalf("count legacy leftovers: %v", err)
	}
	if legacyLeft != 0 {
		t.Fatalf("legacy objects remain after the baseline (identity schema, organization tables, or RLS): %d", legacyLeft)
	}

	var userSystemTables int
	if err := conn.QueryRow(ctx, `
		SELECT count(*) FROM pg_tables
		WHERE schemaname = 'public' AND tablename = ANY (ARRAY['users','sessions','audit_logs'])`).Scan(&userSystemTables); err != nil {
		t.Fatalf("count user-system tables: %v", err)
	}
	if userSystemTables != 3 {
		t.Fatalf("user-system tables after rebuild = %d, want 3", userSystemTables)
	}

	var orgColumn int
	if err := conn.QueryRow(ctx, `
		SELECT count(*) FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'organization_id'`).Scan(&orgColumn); err != nil {
		t.Fatalf("inspect audit_logs columns: %v", err)
	}
	if orgColumn != 0 {
		t.Fatal("rebuilt audit_logs still carries the organization dimension")
	}
}
