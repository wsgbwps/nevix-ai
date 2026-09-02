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

	var slotReasonConstraint string
	if err := db.QueryRowContext(ctx,
		`SELECT pg_get_constraintdef(oid)
		 FROM pg_constraint
		 WHERE conrelid = 'public.creation_generation_slots'::regclass
		   AND conname = 'creation_generation_slots_reason_check'`,
	).Scan(&slotReasonConstraint); err != nil {
		t.Fatalf("inspect generation-slot failure taxonomy: %v", err)
	}
	if !strings.Contains(slotReasonConstraint, "provider_route_unavailable") {
		t.Fatalf("generation-slot failure taxonomy lacks provider_route_unavailable: %s", slotReasonConstraint)
	}

	for _, column := range []string{
		"failure_diagnostic_source", "failure_diagnostic_code", "failure_diagnostic_message",
		"failure_diagnostic_http_status", "failure_diagnostic_provider_type", "failure_diagnostic_request_id",
	} {
		var exists bool
		if err := db.QueryRowContext(ctx,
			`SELECT EXISTS (
				SELECT FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'creation_generation_slots' AND column_name = $1
			)`, column,
		).Scan(&exists); err != nil {
			t.Fatalf("inspect generation-slot diagnostic column %s: %v", column, err)
		}
		if !exists {
			t.Fatalf("generation-slot diagnostic column %s does not exist", column)
		}
	}
	var diagnosticConstraint string
	if err := db.QueryRowContext(ctx,
		`SELECT pg_get_constraintdef(oid)
		 FROM pg_constraint
		 WHERE conrelid = 'public.creation_generation_slots'::regclass
		   AND conname = 'creation_generation_slots_failure_diagnostic_check'`,
	).Scan(&diagnosticConstraint); err != nil {
		t.Fatalf("inspect generation-slot diagnostic constraint: %v", err)
	}
	for _, required := range []string{"output_transfer", "char_length(failure_diagnostic_message)", "failure_diagnostic_http_status"} {
		if !strings.Contains(diagnosticConstraint, required) {
			t.Fatalf("generation-slot diagnostic constraint lacks %q: %s", required, diagnosticConstraint)
		}
	}

	var diagnosticUserID, diagnosticSessionID, diagnosticTaskID string
	if err := db.QueryRowContext(ctx,
		`INSERT INTO public.users (email, password_hash, display_name, role, status, must_change_password)
		 VALUES ('diagnostic-constraint@nevix.test', 'seed-hash', 'diagnostic-constraint', 'member', 'active', false)
		 RETURNING id`,
	).Scan(&diagnosticUserID); err != nil {
		t.Fatalf("seed diagnostic user: %v", err)
	}
	if err := db.QueryRowContext(ctx,
		`INSERT INTO public.creation_sessions (owner_user_id, name)
		 VALUES ($1, 'diagnostic constraint') RETURNING id`, diagnosticUserID,
	).Scan(&diagnosticSessionID); err != nil {
		t.Fatalf("seed diagnostic session: %v", err)
	}
	if err := db.QueryRowContext(ctx,
		`INSERT INTO public.creation_generation_tasks
		 (session_id, owner_user_id, idempotency_key, payload_hash, media_type,
		  specification, manifest_version, draft_revision, status, slot_count, terminal_at)
		 VALUES ($1, $2, 'diagnostic-constraint', 'seed-payload', 'image', '{}'::jsonb, 1, now(), 'failed', 3, now())
		 RETURNING id`, diagnosticSessionID, diagnosticUserID,
	).Scan(&diagnosticTaskID); err != nil {
		t.Fatalf("seed diagnostic task: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO public.creation_generation_slots
		 (task_id, slot_index, status, failure_reason, failure_diagnostic_source,
		  failure_diagnostic_code, failure_diagnostic_message)
		 VALUES ($1, 0, NULL, NULL, 'provider', 'provider_error', 'must not attach to a projected slot')`,
		diagnosticTaskID,
	); err == nil {
		t.Fatal("diagnostic on a non-terminal projected slot must be rejected")
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO public.creation_generation_slots
		 (task_id, slot_index, status, failure_reason, failure_diagnostic_source,
		  failure_diagnostic_message)
		 VALUES ($1, 1, 'failed', 'internal_error', 'provider', 'missing code must be rejected')`,
		diagnosticTaskID,
	); err == nil {
		t.Fatal("partial diagnostic without code must be rejected")
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO public.creation_generation_slots
		 (task_id, slot_index, status, failure_reason, failure_diagnostic_source,
		  failure_diagnostic_code, failure_diagnostic_message)
		 VALUES ($1, 2, 'failed', 'internal_error', 'provider', 'provider_error', 'complete diagnostic')`,
		diagnosticTaskID,
	); err != nil {
		t.Fatalf("complete terminal diagnostic rejected: %v", err)
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

func TestUpgradeBackfillsAndRequeuesOnlyKnownTransientSubmits(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	ownerURL := requireOwnerURL(t)
	scratchURL := scratchDatabase(t, ctx, ownerURL, "nevix_migration_submit_attempts")

	preSubmitBudget := embeddedMigrationsBefore(t, 10)
	if _, err := applyFS(ctx, scratchURL, preSubmitBudget); err != nil {
		t.Fatalf("apply migrations through v9: %v", err)
	}

	db := openDB(t, ctx, scratchURL)
	var userID, sessionID string
	if err := db.QueryRowContext(ctx,
		`INSERT INTO public.users (email, password_hash, display_name, role, status, must_change_password)
		 VALUES ('submit-upgrade@nevix.test', 'seed-hash', 'submit-upgrade', 'member', 'active', false)
		 RETURNING id`,
	).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := db.QueryRowContext(ctx,
		`INSERT INTO public.creation_sessions (owner_user_id, name)
		 VALUES ($1, 'submit upgrade') RETURNING id`, userID,
	).Scan(&sessionID); err != nil {
		t.Fatalf("seed session: %v", err)
	}

	seedSubmit := func(key, outcome string) (taskID, jobID string) {
		t.Helper()
		if err := db.QueryRowContext(ctx,
			`INSERT INTO public.creation_generation_tasks
			 (session_id, owner_user_id, idempotency_key, payload_hash, media_type,
			  specification, manifest_version, draft_revision, status, slot_count)
			 VALUES ($1, $2, $3, 'seed-payload', 'image', '{}'::jsonb, 1, now(), 'submitting', 1)
			 RETURNING id`, sessionID, userID, key,
		).Scan(&taskID); err != nil {
			t.Fatalf("seed task %s: %v", key, err)
		}
		if err := db.QueryRowContext(ctx,
			`INSERT INTO public.creation_provider_jobs (task_id, media_type, status, last_outcome)
			 VALUES ($1, 'image', 'submitting', NULLIF($2, '')) RETURNING id`, taskID, outcome,
		).Scan(&jobID); err != nil {
			t.Fatalf("seed provider job %s: %v", key, err)
		}
		if _, err := db.ExecContext(ctx,
			`INSERT INTO public.creation_generation_queue
			 (task_id, media_type, run_after, lease_owner, lease_until, attempts, max_attempts)
			 VALUES ($1, 'image', now() + interval '1 hour', 'old-worker', now() + interval '1 hour', 240, 240)`, taskID,
		); err != nil {
			t.Fatalf("seed queue %s: %v", key, err)
		}
		return taskID, jobID
	}
	knownTaskID, knownJobID := seedSubmit("known-transient", "transient_rejected")
	unknownTaskID, unknownJobID := seedSubmit("unknown-outcome", "")

	applied, err := Apply(ctx, scratchURL)
	if err != nil {
		t.Fatalf("upgrade through submit-attempt migration: %v", err)
	}
	foundV10 := false
	for _, result := range applied {
		foundV10 = foundV10 || result.Source.Version == 10
	}
	if !foundV10 {
		t.Fatalf("upgrade did not apply migration 10: %+v", applied)
	}

	var attempts int
	if err := db.QueryRowContext(ctx,
		`SELECT submit_attempts FROM public.creation_provider_jobs WHERE id = $1`, knownJobID,
	).Scan(&attempts); err != nil {
		t.Fatalf("read known transient job: %v", err)
	}
	if attempts != 3 {
		t.Fatalf("known transient submit_attempts = %d, want 3", attempts)
	}
	var queueAttempts int
	var runnable, leaseCleared bool
	if err := db.QueryRowContext(ctx,
		`SELECT attempts, run_after <= now(), lease_owner IS NULL AND lease_until IS NULL
		 FROM public.creation_generation_queue WHERE task_id = $1`, knownTaskID,
	).Scan(&queueAttempts, &runnable, &leaseCleared); err != nil {
		t.Fatalf("read known transient queue: %v", err)
	}
	if queueAttempts != 0 || !runnable || !leaseCleared {
		t.Fatalf("known transient queue = attempts %d, runnable %v, lease cleared %v; want 0, true, true", queueAttempts, runnable, leaseCleared)
	}

	// The recovered final submit consumes one queue claim. If the provider
	// accepts async work, that same row must still have headroom for polling;
	// submit_attempts, not this generic counter, prevents a fifth submit.
	if err := db.QueryRowContext(ctx,
		`UPDATE public.creation_generation_queue
		 SET attempts = attempts + 1, lease_owner = 'new-worker', lease_until = now() + interval '1 minute'
		 WHERE task_id = $1 AND attempts < max_attempts
		 RETURNING attempts`, knownTaskID,
	).Scan(&queueAttempts); err != nil {
		t.Fatalf("claim recovered submit: %v", err)
	}
	if queueAttempts != 1 {
		t.Fatalf("recovered submit claim attempts = %d, want 1", queueAttempts)
	}
	if _, err := db.ExecContext(ctx,
		`UPDATE public.creation_provider_jobs
		 SET submit_attempts = submit_attempts + 1, last_outcome = NULL, external_ref = 'accepted-async'
		 WHERE id = $1`, knownJobID,
	); err != nil {
		t.Fatalf("persist accepted async recovery: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`UPDATE public.creation_generation_queue
		 SET run_after = now(), lease_owner = NULL, lease_until = NULL
		 WHERE task_id = $1`, knownTaskID,
	); err != nil {
		t.Fatalf("release accepted async recovery: %v", err)
	}
	var pollClaimable bool
	if err := db.QueryRowContext(ctx,
		`SELECT submit_attempts = 4
		   AND EXISTS (
		     SELECT 1 FROM public.creation_generation_queue
		     WHERE task_id = $2 AND attempts < max_attempts
		       AND run_after <= now() AND lease_until IS NULL
		   )
		 FROM public.creation_provider_jobs WHERE id = $1`, knownJobID, knownTaskID,
	).Scan(&pollClaimable); err != nil {
		t.Fatalf("inspect accepted async recovery: %v", err)
	}
	if !pollClaimable {
		t.Fatal("accepted async recovery has no queue headroom for its first poll")
	}

	if err := db.QueryRowContext(ctx,
		`SELECT submit_attempts FROM public.creation_provider_jobs WHERE id = $1`, unknownJobID,
	).Scan(&attempts); err != nil {
		t.Fatalf("read unknown-outcome job: %v", err)
	}
	if attempts != 0 {
		t.Fatalf("unknown-outcome submit_attempts = %d, want 0", attempts)
	}
	var leaseOwner *string
	if err := db.QueryRowContext(ctx,
		`SELECT attempts, lease_owner FROM public.creation_generation_queue WHERE task_id = $1`, unknownTaskID,
	).Scan(&queueAttempts, &leaseOwner); err != nil {
		t.Fatalf("read unknown-outcome queue: %v", err)
	}
	if queueAttempts != 240 || leaseOwner == nil || *leaseOwner != "old-worker" {
		t.Fatalf("unknown-outcome queue = attempts %d, lease owner %v; want 240, old-worker", queueAttempts, leaseOwner)
	}
}

func TestUpgradeAddsProviderRouteFailureConstraint(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	ownerURL := requireOwnerURL(t)
	scratchURL := scratchDatabase(t, ctx, ownerURL, "nevix_migration_provider_route_failure")

	if _, err := applyFS(ctx, scratchURL, embeddedMigrationsBefore(t, 11)); err != nil {
		t.Fatalf("apply migrations through v10: %v", err)
	}

	db := openDB(t, ctx, scratchURL)
	var userID, sessionID, taskID string
	if err := db.QueryRowContext(ctx,
		`INSERT INTO public.users (email, password_hash, display_name, role, status, must_change_password)
		 VALUES ('route-upgrade@nevix.test', 'seed-hash', 'route-upgrade', 'member', 'active', false)
		 RETURNING id`,
	).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := db.QueryRowContext(ctx,
		`INSERT INTO public.creation_sessions (owner_user_id, name)
		 VALUES ($1, 'route upgrade') RETURNING id`, userID,
	).Scan(&sessionID); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	if err := db.QueryRowContext(ctx,
		`INSERT INTO public.creation_generation_tasks
		 (session_id, owner_user_id, idempotency_key, payload_hash, media_type,
		  specification, manifest_version, draft_revision, status, slot_count, terminal_at)
		 VALUES ($1, $2, 'route-upgrade', 'seed-payload', 'image', '{}'::jsonb, 1, now(), 'failed', 1, now())
		 RETURNING id`, sessionID, userID,
	).Scan(&taskID); err != nil {
		t.Fatalf("seed failed task: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO public.creation_generation_slots (task_id, slot_index, status, failure_reason)
		 VALUES ($1, 0, 'failed', 'temporarily_unavailable')`, taskID,
	); err != nil {
		t.Fatalf("seed failed slot: %v", err)
	}

	applied, err := Apply(ctx, scratchURL)
	if err != nil {
		t.Fatalf("upgrade through provider-route migration: %v", err)
	}
	foundV11 := false
	for _, result := range applied {
		foundV11 = foundV11 || result.Source.Version == 11
	}
	if !foundV11 {
		t.Fatalf("upgrade did not apply migration 11: %+v", applied)
	}

	if _, err := db.ExecContext(ctx,
		`UPDATE public.creation_generation_slots
		 SET failure_reason = 'provider_route_unavailable'
		 WHERE task_id = $1 AND slot_index = 0`, taskID,
	); err != nil {
		t.Fatalf("new provider-route reason rejected after upgrade: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`UPDATE public.creation_generation_slots
		 SET failure_reason = 'unknown_provider_failure'
		 WHERE task_id = $1 AND slot_index = 0`, taskID,
	); err == nil {
		t.Fatal("unknown failure reason must remain rejected after upgrade")
	}
	var reason string
	if err := db.QueryRowContext(ctx,
		`SELECT failure_reason FROM public.creation_generation_slots
		 WHERE task_id = $1 AND slot_index = 0`, taskID,
	).Scan(&reason); err != nil {
		t.Fatalf("read upgraded slot reason: %v", err)
	}
	if reason != "provider_route_unavailable" {
		t.Fatalf("slot reason = %q after rejected unknown update, want provider_route_unavailable", reason)
	}
}

func TestUpgradeRequiresImageRecheckForSeedreamPro(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	ownerURL := requireOwnerURL(t)
	scratchURL := scratchDatabase(t, ctx, ownerURL, "nevix_migration_seedream_pro_recheck")

	if _, err := applyFS(ctx, scratchURL, embeddedMigrationsBefore(t, 12)); err != nil {
		t.Fatalf("apply migrations through v11: %v", err)
	}

	db := openDB(t, ctx, scratchURL)
	var userID, connectionID string
	if err := db.QueryRowContext(ctx,
		`INSERT INTO public.users (email, password_hash, display_name, role, status, must_change_password)
		 VALUES ('pro-recheck@nevix.test', 'seed-hash', 'pro-recheck', 'admin', 'active', false)
		 RETURNING id`,
	).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := db.QueryRowContext(ctx,
		`INSERT INTO public.provider_connections
		 (admin_state, credential_state, image_capability, video_capability,
		  envelope_version, credential_key_id, credential_nonce, credential_ciphertext,
		  last_checked_at, last_check_outcome, created_by_user_id)
		 VALUES ('enabled', 'valid', 'available', 'available', 1, 'seed-key',
		         decode('00', 'hex'), decode('01', 'hex'), now(), 'completed', $1)
		 RETURNING id`, userID,
	).Scan(&connectionID); err != nil {
		t.Fatalf("seed checked provider connection: %v", err)
	}

	applied, err := Apply(ctx, scratchURL)
	if err != nil {
		t.Fatalf("upgrade through Seedream Pro recheck migration: %v", err)
	}
	foundV12 := false
	for _, result := range applied {
		foundV12 = foundV12 || result.Source.Version == 12
	}
	if !foundV12 {
		t.Fatalf("upgrade did not apply migration 12: %+v", applied)
	}

	var imageCapability, videoCapability string
	var checkedAt, outcome *string
	if err := db.QueryRowContext(ctx,
		`SELECT image_capability, video_capability, last_checked_at::text, last_check_outcome
		 FROM public.provider_connections WHERE id = $1`, connectionID,
	).Scan(&imageCapability, &videoCapability, &checkedAt, &outcome); err != nil {
		t.Fatalf("read upgraded provider connection: %v", err)
	}
	if imageCapability != "checking" || videoCapability != "available" {
		t.Fatalf("upgraded capabilities = image %s, video %s; want checking, available", imageCapability, videoCapability)
	}
	if checkedAt != nil || outcome != nil {
		t.Fatalf("old Lite catalog verdict survived Pro upgrade: checked_at=%v outcome=%v", checkedAt, outcome)
	}
}

func embeddedMigrationsBefore(t *testing.T, versionLimit int64) fstest.MapFS {
	t.Helper()
	selected := fstest.MapFS{}
	entries, err := os.ReadDir("migrations")
	if err != nil {
		t.Fatalf("read migrations: %v", err)
	}
	for _, entry := range entries {
		stem, _, ok := strings.Cut(entry.Name(), "_")
		if !ok {
			continue
		}
		version, err := strconv.ParseInt(stem, 10, 64)
		if err != nil || version >= versionLimit {
			continue
		}
		contents, err := os.ReadFile("migrations/" + entry.Name())
		if err != nil {
			t.Fatalf("read migration %s: %v", entry.Name(), err)
		}
		selected["migrations/"+entry.Name()] = &fstest.MapFile{Data: contents}
	}
	return selected
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
