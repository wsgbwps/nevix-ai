// Real-PostgreSQL evidence for the Goose-backed migration path (issue #108):
// first apply on an empty database creates the single-tenant baseline and the
// goose_db_version ledger (never public.schema_migrations), re-apply is a
// no-op, a failed migration rolls back its transaction and stays unrecorded,
// and concurrent startups serialize on Goose's session lock so the baseline
// is applied exactly once. Harness helpers live in harness_test.go.
package migration

import (
	"context"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/pressly/goose/v3"
)

func TestApplyCreatesBaselineAndGooseLedgerOnEmptyDatabase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	ownerURL := requireOwnerURL(t)
	scratchURL := scratchDatabase(t, ctx, ownerURL, "nevix_migration_first_apply")

	applied, err := Apply(ctx, scratchURL)
	if err != nil {
		t.Fatalf("apply on empty database: %v", err)
	}
	// Expected set derives from the embedded files themselves so appending a
	// future up-only migration never needs to touch this sentinel again.
	expected := embeddedVersions(t)
	if len(applied) != len(expected) {
		t.Fatalf("applied %d migrations, want %d: %+v", len(applied), len(expected), applied)
	}
	for i, want := range expected {
		if applied[i].Source.Version != want {
			t.Fatalf("applied[%d].Version = %d, want %d (lexicographic order)", i, applied[i].Source.Version, want)
		}
	}

	db := openDB(t, ctx, scratchURL)

	// The single-tenant world exists after the production startup path.
	for _, table := range []string{"users", "sessions", "audit_logs", "join_codes"} {
		var exists bool
		if err := db.QueryRowContext(ctx,
			`SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = $1)`, table,
		).Scan(&exists); err != nil {
			t.Fatalf("inspect table %s: %v", table, err)
		}
		if !exists {
			t.Fatalf("baseline table public.%s does not exist", table)
		}
	}

	// The established role and least-privilege grants (ADR-0015), including
	// the DDL boundary: identity_app may not create schema objects.
	for probe, want := range map[string]bool{
		`has_table_privilege('identity_app', 'public.users', 'SELECT')`:                                  true,
		`has_table_privilege('identity_app', 'public.sessions', 'DELETE')`:                               true,
		`has_table_privilege('identity_app', 'public.audit_logs', 'UPDATE')`:                             false,
		`has_schema_privilege('identity_app', 'public', 'CREATE')`:                                       false,
		`EXISTS (SELECT FROM pg_roles WHERE rolname = 'identity_app')`:                                   true,
		`EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'goose_db_version')`:  true,
		`EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations')`: false,
	} {
		var got bool
		if err := db.QueryRowContext(ctx, "SELECT "+probe).Scan(&got); err != nil {
			t.Fatalf("probe %s: %v", probe, err)
		}
		if got != want {
			t.Fatalf("probe %s = %v, want %v", probe, got, want)
		}
	}

	// Versions live only in Goose's standard ledger, with the baseline and
	// its first up-only successor recorded as applied.
	for _, version := range []int64{1, 2} {
		var recorded int
		if err := db.QueryRowContext(ctx,
			`SELECT count(*) FROM public.goose_db_version WHERE version_id = $1 AND is_applied`, version,
		).Scan(&recorded); err != nil {
			t.Fatalf("read goose ledger for version %d: %v", version, err)
		}
		if recorded != 1 {
			t.Fatalf("goose_db_version records version %d %d times, want exactly 1", version, recorded)
		}
	}

	// The up-only successor ran: the never-logged-in marker exists on users.
	var hasColumn bool
	if err := db.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'last_login_at')`,
	).Scan(&hasColumn); err != nil {
		t.Fatalf("inspect users.last_login_at: %v", err)
	}
	if !hasColumn {
		t.Fatal("users.last_login_at does not exist; migration 0002 did not run")
	}
}

func TestApplyIsIdempotentWhenAlreadyCurrent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	ownerURL := requireOwnerURL(t)
	scratchURL := scratchDatabase(t, ctx, ownerURL, "nevix_migration_idempotent")

	if _, err := Apply(ctx, scratchURL); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	applied, err := Apply(ctx, scratchURL)
	if err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	if len(applied) != 0 {
		t.Fatalf("re-apply ran %d migrations, want 0: versions must be recorded exactly once", len(applied))
	}
}

func TestFailedMigrationRollsBackAndStaysUnrecorded(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	ownerURL := requireOwnerURL(t)
	scratchURL := scratchDatabase(t, ctx, ownerURL, "nevix_migration_rollback")

	set := fstest.MapFS{
		"migrations/0001_ok.sql": &fstest.MapFile{Data: []byte(
			"-- +goose Up\nCREATE TABLE public.rollback_probe_ok (id integer NOT NULL);\n")},
		"migrations/0002_bad.sql": &fstest.MapFile{Data: []byte(
			"-- +goose Up\nCREATE TABLE public.rollback_probe_bad (id integer NOT NULL);\n\nDROP TABLE public.no_such_table_xyz;\n")},
	}

	if _, err := applyFS(ctx, scratchURL, set); err == nil {
		t.Fatal("apply succeeded despite a failing migration; the failure must surface to startup")
	}

	db := openDB(t, ctx, scratchURL)
	for probe, want := range map[string]bool{
		`EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rollback_probe_ok')`:  true,
		`EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rollback_probe_bad')`: false,
		`EXISTS (SELECT FROM public.goose_db_version WHERE version_id = 1 AND is_applied)`:                true,
		`EXISTS (SELECT FROM public.goose_db_version WHERE version_id = 2)`:                               false,
	} {
		var got bool
		if err := db.QueryRowContext(ctx, "SELECT "+probe).Scan(&got); err != nil {
			t.Fatalf("probe %s: %v", probe, err)
		}
		if got != want {
			t.Fatalf("probe %s = %v, want %v", probe, got, want)
		}
	}
}

func TestConcurrentApplyRunsTheEmbeddedSetExactlyOnce(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	ownerURL := requireOwnerURL(t)
	scratchURL := scratchDatabase(t, ctx, ownerURL, "nevix_migration_concurrent")

	const starters = 2
	var ready, done sync.WaitGroup
	ready.Add(1)
	results := make([][]*goose.MigrationResult, starters)
	errs := make([]error, starters)
	for i := 0; i < starters; i++ {
		done.Add(1)
		go func(i int) {
			defer done.Done()
			ready.Wait() // both starters race the same empty database at once
			applied, err := Apply(ctx, scratchURL)
			errs[i] = err
			results[i] = applied
		}(i)
	}
	ready.Done()
	done.Wait()

	totalApplied := 0
	for i := 0; i < starters; i++ {
		if errs[i] != nil {
			t.Fatalf("concurrent apply %d failed: %v", i, errs[i])
		}
		totalApplied += len(results[i])
	}
	if expectedCount := len(embeddedVersions(t)); totalApplied != expectedCount {
		t.Fatalf("concurrent applies ran %d migrations in total, want exactly the %d embedded ones (each once)", totalApplied, expectedCount)
	}

	db := openDB(t, ctx, scratchURL)
	for _, version := range []int64{1, 2, 3, 4} {
		var recorded int
		if err := db.QueryRowContext(ctx,
			`SELECT count(*) FROM public.goose_db_version WHERE version_id = $1 AND is_applied`, version,
		).Scan(&recorded); err != nil {
			t.Fatalf("read goose ledger for version %d: %v", version, err)
		}
		if recorded != 1 {
			t.Fatalf("goose_db_version records version %d %d times, want exactly 1", version, recorded)
		}
	}
	var usersExists bool
	if err := db.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users')`,
	).Scan(&usersExists); err != nil {
		t.Fatalf("inspect users table: %v", err)
	}
	if !usersExists {
		t.Fatal("public.users does not exist after concurrent startup")
	}
}

// A baseline-v1 deployment upgrading to the 0002 world keeps the
// never-logged-in invariant: accounts with live sessions or session_created
// audit evidence are backfilled as logged-in; an account with no evidence
// stays NULL (issue #102 review).
func TestUpgradeFromBaselineBackfillsLastLogin(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	ownerURL := requireOwnerURL(t)
	scratchURL := scratchDatabase(t, ctx, ownerURL, "nevix_migration_upgrade_backfill")

	// Bring the scratch database to exactly baseline v1: the controlled set
	// carries only the real 0001 file.
	baselineSQL, err := os.ReadFile("migrations/0001_baseline_user_system.sql")
	if err != nil {
		t.Fatalf("read baseline migration: %v", err)
	}
	v1Only := fstest.MapFS{
		"migrations/0001_baseline_user_system.sql": &fstest.MapFile{Data: baselineSQL},
	}
	if _, err := applyFS(ctx, scratchURL, v1Only); err != nil {
		t.Fatalf("apply baseline v1: %v", err)
	}

	db := openDB(t, ctx, scratchURL)
	seed := func(email string) string {
		var id string
		if err := db.QueryRowContext(ctx,
			`INSERT INTO public.users (email, password_hash, display_name, role, status, must_change_password)
			 VALUES ($1, 'seed-hash', $1, 'member', 'active', false) RETURNING id`, email,
		).Scan(&id); err != nil {
			t.Fatalf("seed %s: %v", email, err)
		}
		return id
	}
	alice := seed("alice@nevix.test") // live session
	bob := seed("bob@nevix.test")     // no evidence at all
	carol := seed("carol@nevix.test") // sessions all revoked; audit row remains

	if _, err := db.ExecContext(ctx,
		`INSERT INTO public.sessions (user_id, token_hash, device_name, expires_at)
		 VALUES ($1, decode('aa','hex'), 'alice-device', now() + interval '1 day')`, alice,
	); err != nil {
		t.Fatalf("seed alice session: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO public.audit_logs (actor_user_id, actor_display_name, action, metadata, created_at)
		 VALUES ($1, 'carol@nevix.test', 'session_created', '{}'::jsonb, now() - interval '2 hours')`, carol,
	); err != nil {
		t.Fatalf("seed carol audit row: %v", err)
	}

	// The production startup path now applies everything after the baseline
	// (v1 is already recorded); later migrations ride along without touching
	// the backfill under test. Expectations derive from the embedded set so
	// appending future up-only migrations keeps this sentinel true.
	applied, err := Apply(ctx, scratchURL)
	if err != nil {
		t.Fatalf("upgrade past baseline: %v", err)
	}
	expected := embeddedVersions(t)[1:] // everything except baseline v1
	if len(applied) != len(expected) {
		t.Fatalf("upgrade applied %d migrations, want %d: %+v", len(applied), len(expected), applied)
	}
	for i, want := range expected {
		if applied[i].Source.Version != want {
			t.Fatalf("upgrade[%d].Version = %d, want %d", i, applied[i].Source.Version, want)
		}
	}

	lastLogin := func(userID string) (*time.Time, string) {
		var stamp *time.Time
		var email string
		if err := db.QueryRowContext(ctx,
			`SELECT last_login_at, email FROM public.users WHERE id = $1`, userID,
		).Scan(&stamp, &email); err != nil {
			t.Fatalf("read %s: %v", userID, err)
		}
		return stamp, email
	}
	for _, userID := range []string{alice, carol} {
		stamp, email := lastLogin(userID)
		if stamp == nil {
			t.Fatalf("%s upgraded with NULL last_login_at despite login evidence", email)
		}
	}
	if stamp, email := lastLogin(bob); stamp != nil {
		t.Fatalf("%s upgraded with last_login_at %v despite never logging in", email, stamp)
	}
}

// embeddedVersions lists the migration file numbers present under
// migrations/, in lexicographic (application) order.
func embeddedVersions(t *testing.T) []int64 {
	t.Helper()
	entries, err := os.ReadDir("migrations")
	if err != nil {
		t.Fatalf("read embedded migrations directory: %v", err)
	}
	var versions []int64
	for _, entry := range entries {
		stem, _, ok := strings.Cut(entry.Name(), "_")
		if !ok {
			continue
		}
		version, err := strconv.ParseInt(stem, 10, 64)
		if err != nil {
			continue
		}
		versions = append(versions, version)
	}
	return versions
}
