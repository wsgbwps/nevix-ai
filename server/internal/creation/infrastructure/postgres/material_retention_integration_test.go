package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
	"github.com/nevix-ai/server/internal/creation/infrastructure/writetx"
	"github.com/nevix-ai/server/internal/migration"
)

func TestFinalTaskReferenceReleaseSchedulesOnlyRemovedMaterialCleanup(t *testing.T) {
	ownerURL, runtimeURL := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner pool: %v", err)
	}
	defer owner.Close()
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect runtime pool: %v", err)
	}
	defer runtime.Close()
	creator := fixtureUser(t, ownerURL)
	sessionID := fixtureSession(t, ownerURL, owner, creator)
	materialID := fixtureRetainedMaterial(t, owner, sessionID)
	otherMaterialID := fixtureRetainedMaterial(t, owner, sessionID)
	cleanupID, otherCleanupID := domain.NewUUID(), domain.NewUUID()
	if _, err := owner.Exec(ctx, `
		INSERT INTO creation_reference_material_uploads
		(id, owner_user_id, session_id, material_id, object_key, file_name, declared_kind,
		 declared_mime_type, declared_byte_size, claims_version, idempotency_key, payload_hash,
		 connection_revision, put_deadline, finalize_deadline, status, created_at, finalized_at)
		SELECT id, $1, $2, material_id, material_id::text, 'fixture.png', 'image', 'image/png', 1, 1,
		       id::text, decode(repeat('00', 32), 'hex'), 1,
		       now() - interval '31 minutes', now() - interval '1 minute', 'finalized',
		       now() - interval '91 minutes', now()
		FROM (VALUES ($3::uuid, $4::uuid), ($5::uuid, $6::uuid)) AS cleanup(id, material_id)`,
		creator, sessionID, cleanupID, materialID, otherCleanupID, otherMaterialID); err != nil {
		t.Fatalf("seed dormant cleanup facts: %v", err)
	}
	t.Cleanup(func() {
		pool, err := pgxpool.New(ctx, ownerURL)
		if err != nil {
			t.Errorf("connect cleanup pool: %v", err)
			return
		}
		defer pool.Close()
		if _, err := pool.Exec(ctx, `DELETE FROM creation_reference_material_uploads WHERE session_id = $1`, sessionID); err != nil {
			t.Errorf("cleanup upload facts: %v", err)
		}
	})
	first := fixtureGenerationTask(t, ownerURL, owner, creator, sessionID)
	second := fixtureGenerationTask(t, ownerURL, owner, creator, sessionID)
	if _, err := runtime.Exec(ctx, `
		INSERT INTO creation_generation_task_references (task_id, material_id)
		VALUES ($1, $3), ($2, $3), ($1, $4)`, first, second, materialID, otherMaterialID); err != nil {
		t.Fatalf("retain shared material: %v", err)
	}
	tx, err := runtime.Begin(ctx)
	if err != nil {
		t.Fatalf("begin removal: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, retained, err := NewMaterialRepository(runtime).Remove(ctx, tx, creator, materialID); err != nil || !retained {
		t.Fatalf("remove retained material: retained=%t err=%v", retained, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit removal: %v", err)
	}
	for i, taskID := range []domain.UUID{first, second} {
		// Physical task deletion also cascades through this relation trigger.
		if _, err := owner.Exec(ctx, `DELETE FROM creation_generation_tasks WHERE id = $1`, taskID); err != nil {
			t.Fatalf("release retaining task: %v", err)
		}
		var due bool
		var attempts int
		if err := runtime.QueryRow(ctx, `
			SELECT cleanup_next_attempt_at IS NOT NULL, cleanup_attempt_count
			FROM creation_reference_material_uploads WHERE id = $1`, cleanupID).Scan(&due, &attempts); err != nil {
			t.Fatalf("read released cleanup: %v", err)
		}
		if due != (i == 1) || (due && attempts != 1) {
			t.Fatalf("cleanup before final release: release=%d due=%t attempts=%d", i+1, due, attempts)
		}
	}
	var unrelatedDue bool
	if err := runtime.QueryRow(ctx, `
		SELECT cleanup_next_attempt_at IS NOT NULL FROM creation_reference_material_uploads
		WHERE id = $1`, otherCleanupID).Scan(&unrelatedDue); err != nil || unrelatedDue {
		t.Fatalf("final release affected another object: due=%t err=%v", unrelatedDue, err)
	}
	tx, err = runtime.Begin(ctx)
	if err != nil {
		t.Fatalf("begin due cleanup: %v", err)
	}
	defer tx.Rollback(ctx)
	uploads := NewReferenceMaterialUploadRepository(runtime)
	var cleanupAt time.Time
	if err := tx.QueryRow(ctx, `
		SELECT cleanup_next_attempt_at FROM creation_reference_material_uploads
		WHERE id = $1`, cleanupID).Scan(&cleanupAt); err != nil {
		t.Fatalf("read scheduled cleanup time: %v", err)
	}
	due, err := uploads.LockDueCleanups(ctx, tx, cleanupAt, 10, nil)
	if err != nil || len(due) != 1 || due[0].ID != cleanupID || due[0].ObjectKey != materialID.String() {
		t.Fatalf("final release must expose only its exact cleanup key: due=%+v err=%v", due, err)
	}
	attempt, err := uploads.MarkCleanupAttempt(ctx, tx, cleanupID, cleanupAt.Add(time.Minute))
	if err != nil {
		t.Fatalf("mark released cleanup attempt: %v", err)
	}
	if err := uploads.MarkCleanupConfirmed(ctx, tx, cleanupID, attempt.Attempt, cleanupAt); err != nil {
		t.Fatalf("confirm released cleanup: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit released cleanup: %v", err)
	}
	var remaining int
	if err := runtime.QueryRow(ctx, `SELECT count(*) FROM creation_reference_materials WHERE id = $1`, materialID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("confirmed final-release cleanup kept removed metadata: count=%d err=%v", remaining, err)
	}
}

func TestSessionDeletionSchedulesOnlyObjectsWithoutOtherHolders(t *testing.T) {
	ownerURL, runtimeURL := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner pool: %v", err)
	}
	defer owner.Close()
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect runtime pool: %v", err)
	}
	defer runtime.Close()

	creator := fixtureUser(t, ownerURL)
	sessionID := fixtureSession(t, ownerURL, owner, creator)
	shared := fixtureRetainedMaterial(t, owner, sessionID)
	unshared := fixtureRetainedMaterial(t, owner, sessionID)
	aliasSessionID := fixtureSession(t, ownerURL, owner, creator)
	if _, err := owner.Exec(ctx, `
		INSERT INTO creation_reference_materials
			(id, session_id, kind, file_name, mime_type, byte_size, checksum_sha256,
			 blob_key, width_px, height_px, pixel_count)
		SELECT $1, $2, kind, file_name, mime_type, byte_size, checksum_sha256,
		       blob_key, width_px, height_px, pixel_count
		FROM creation_reference_materials WHERE id = $3`, domain.NewUUID(), aliasSessionID, shared); err != nil {
		t.Fatalf("seed shared object alias: %v", err)
	}
	sharedCleanup := seedFinalizedUpload(t, ctx, owner, publicationFixture{
		creator: creator, sessionID: sessionID, materialID: shared, materialBlobKey: shared.String(),
	})
	unsharedCleanup := seedFinalizedUpload(t, ctx, owner, publicationFixture{
		creator: creator, sessionID: sessionID, materialID: unshared, materialBlobKey: unshared.String(),
	})
	t.Cleanup(func() {
		pool, err := pgxpool.New(ctx, ownerURL)
		if err != nil {
			t.Errorf("connect cleanup pool: %v", err)
			return
		}
		defer pool.Close()
		if _, err := pool.Exec(ctx, `DELETE FROM creation_reference_material_uploads WHERE session_id = $1`, sessionID); err != nil {
			t.Errorf("cleanup upload facts: %v", err)
		}
	})
	first := fixtureGenerationTask(t, ownerURL, owner, creator, sessionID)
	second := fixtureGenerationTask(t, ownerURL, owner, creator, sessionID)
	if _, err := runtime.Exec(ctx, `
		INSERT INTO creation_generation_task_references (task_id, material_id)
		VALUES ($1, $3), ($2, $3)`, first, second, shared); err != nil {
		t.Fatalf("retain shared object: %v", err)
	}
	rollbackTx, err := runtime.Begin(ctx)
	if err != nil {
		t.Fatalf("begin rollback check: %v", err)
	}
	defer rollbackTx.Rollback(ctx)
	if err := NewSessionRepository(runtime).Delete(ctx, rollbackTx, creator, sessionID); err != nil {
		t.Fatalf("delete session before rollback: %v", err)
	}
	var dueInTx bool
	if err := rollbackTx.QueryRow(ctx, `
		SELECT cleanup_next_attempt_at IS NOT NULL
		FROM creation_reference_material_uploads WHERE id = $1`, unsharedCleanup).Scan(&dueInTx); err != nil || !dueInTx {
		t.Fatalf("cleanup fact missing from delete transaction: due=%t err=%v", dueInTx, err)
	}
	if err := rollbackTx.Rollback(ctx); err != nil {
		t.Fatalf("rollback session deletion: %v", err)
	}
	assertCleanupDue(t, ctx, owner, unsharedCleanup, false)

	tx, err := runtime.Begin(ctx)
	if err != nil {
		t.Fatalf("begin session deletion: %v", err)
	}
	defer tx.Rollback(ctx)
	if err := NewSessionRepository(runtime).Delete(ctx, tx, creator, sessionID); err != nil {
		t.Fatalf("delete session: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit session deletion: %v", err)
	}
	assertCleanupDue(t, ctx, owner, unsharedCleanup, true)
	assertCleanupDue(t, ctx, owner, sharedCleanup, false)

	for index, taskID := range []domain.UUID{first, second} {
		if _, err := runtime.Exec(ctx, `DELETE FROM creation_generation_task_references WHERE task_id = $1`, taskID); err != nil {
			t.Fatalf("release task %d: %v", index+1, err)
		}
		assertCleanupDue(t, ctx, owner, sharedCleanup, false)
	}
	if _, err := runtime.Exec(ctx, `UPDATE creation_sessions SET deleted_at = now() WHERE id = $1`, aliasSessionID); err != nil {
		t.Fatalf("delete alias session: %v", err)
	}
	assertCleanupDue(t, ctx, owner, sharedCleanup, true)
}

func TestSessionDeletionKeepsPublishedMaterialUntilWithdrawal(t *testing.T) {
	ownerURL, runtimeURL := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner pool: %v", err)
	}
	defer owner.Close()
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect runtime pool: %v", err)
	}
	defer runtime.Close()

	fixture := newPublicationFixture(t, ownerURL, owner, true)
	publication := publishFixture(t, ctx, NewTeamPublicationRepository(runtime), writetx.New(runtime), fixture.creator, fixture.assetID, "session-retention")
	cleanupID := seedFinalizedUpload(t, ctx, owner, fixture)
	if _, err := runtime.Exec(ctx, `DELETE FROM creation_generation_task_references WHERE task_id = $1`, fixture.taskID); err != nil {
		t.Fatalf("release task relation: %v", err)
	}
	if _, err := runtime.Exec(ctx, `UPDATE creation_sessions SET deleted_at = now() WHERE id = $1`, fixture.sessionID); err != nil {
		t.Fatalf("delete session: %v", err)
	}
	assertCleanupDue(t, ctx, owner, cleanupID, false)
	if _, err := runtime.Exec(ctx, `UPDATE creation_team_publications SET withdrawn_at = now() WHERE id = $1`, publication.ID); err != nil {
		t.Fatalf("withdraw publication: %v", err)
	}
	assertCleanupDue(t, ctx, owner, cleanupID, true)
}

func TestAdmissionMaterialLockPreventsConcurrentRemoval(t *testing.T) {
	ownerURL, runtimeURL := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner pool: %v", err)
	}
	defer owner.Close()
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect runtime pool: %v", err)
	}
	defer runtime.Close()
	creator := fixtureUser(t, ownerURL)
	sessionID := fixtureSession(t, ownerURL, owner, creator)
	materialID := fixtureRetainedMaterial(t, owner, sessionID)
	tx, err := runtime.Begin(ctx)
	if err != nil {
		t.Fatalf("begin admission: %v", err)
	}
	defer tx.Rollback(ctx)
	materials, err := NewMaterialRepository(runtime).LoadMaterialsInSession(ctx, tx, creator, sessionID, []domain.UUID{materialID})
	if err != nil || len(materials) != 1 {
		t.Fatalf("load admission material: count=%d err=%v", len(materials), err)
	}
	remover, err := owner.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire remover: %v", err)
	}
	defer remover.Release()
	if _, err := remover.Exec(ctx, `SET lock_timeout = '100ms'`); err != nil {
		t.Fatalf("set removal timeout: %v", err)
	}
	_, err = remover.Exec(ctx, `UPDATE creation_reference_materials SET removed_at = now() WHERE id = $1`, materialID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
		t.Fatalf("concurrent removal must wait for admission: %v", err)
	}
}

func TestTaskReferenceReleaseFailureRollsBackDismissal(t *testing.T) {
	ownerURL, runtimeURL := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner pool: %v", err)
	}
	defer owner.Close()
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect runtime pool: %v", err)
	}
	defer runtime.Close()
	creator := fixtureUser(t, ownerURL)
	sessionID := fixtureSession(t, ownerURL, owner, creator)
	materialID := fixtureRetainedMaterial(t, owner, sessionID)
	taskID := fixtureGenerationTask(t, ownerURL, owner, creator, sessionID)
	if _, err := owner.Exec(ctx, `UPDATE creation_generation_tasks
		SET status = 'failed', terminal_at = now() WHERE id = $1`, taskID); err != nil {
		t.Fatalf("terminalize task: %v", err)
	}
	if _, err := runtime.Exec(ctx, `INSERT INTO creation_generation_task_references
		(task_id, material_id) VALUES ($1, $2)`, taskID, materialID); err != nil {
		t.Fatalf("retain material: %v", err)
	}
	if _, err := owner.Exec(ctx, `CREATE FUNCTION test_fail_dismissal_reference_release() RETURNS trigger
		LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected reference release failure'; END $$`); err != nil {
		t.Fatalf("create failure function: %v", err)
	}
	t.Cleanup(func() {
		cleanup, err := pgxpool.New(context.Background(), ownerURL)
		if err != nil {
			t.Errorf("connect cleanup pool: %v", err)
			return
		}
		defer cleanup.Close()
		if _, err := cleanup.Exec(context.Background(), `DROP FUNCTION IF EXISTS test_fail_dismissal_reference_release() CASCADE`); err != nil {
			t.Errorf("drop failure function: %v", err)
		}
	})
	if _, err := owner.Exec(ctx, `CREATE TRIGGER test_fail_dismissal_reference_release
		BEFORE DELETE ON creation_generation_task_references
		FOR EACH ROW EXECUTE FUNCTION test_fail_dismissal_reference_release()`); err != nil {
		t.Fatalf("create failure trigger: %v", err)
	}
	tx, err := runtime.Begin(ctx)
	if err != nil {
		t.Fatalf("begin dismissal: %v", err)
	}
	tasks := NewGenerationTaskRepository(runtime)
	if dismissed, err := tasks.Dismiss(ctx, tx, creator, taskID); err != nil || !dismissed {
		t.Fatalf("dismiss task: dismissed=%t err=%v", dismissed, err)
	}
	if err := tasks.ReleaseReferences(ctx, tx, taskID); err == nil {
		t.Fatal("injected release failure did not abort the transaction")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback dismissal: %v", err)
	}
	var dismissed, retained bool
	if err := owner.QueryRow(ctx, `SELECT dismissed_at IS NOT NULL FROM creation_generation_tasks
		WHERE id = $1`, taskID).Scan(&dismissed); err != nil || dismissed {
		t.Fatalf("failed release left task dismissed: dismissed=%t err=%v", dismissed, err)
	}
	if err := owner.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM creation_generation_task_references
		WHERE task_id = $1 AND material_id = $2)`, taskID, materialID).Scan(&retained); err != nil || !retained {
		t.Fatalf("failed release lost retention: retained=%t err=%v", retained, err)
	}
}

func TestLegacyMaterialRecoveryDisarmsScheduledCleanup(t *testing.T) {
	ownerURL, runtimeURL := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner pool: %v", err)
	}
	defer owner.Close()
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect runtime pool: %v", err)
	}
	defer runtime.Close()
	creator := fixtureUser(t, ownerURL)
	sessionID := fixtureSession(t, ownerURL, owner, creator)
	materialID := fixtureRetainedMaterial(t, owner, sessionID)
	cleanupID := domain.NewUUID()
	if _, err := owner.Exec(ctx, `INSERT INTO creation_reference_material_uploads
		(id, owner_user_id, session_id, material_id, object_key, file_name,
		 declared_kind, declared_mime_type, declared_byte_size, claims_version,
		 idempotency_key, payload_hash, connection_revision, put_deadline,
		 finalize_deadline, status, created_at, finalized_at,
		 cleanup_attempt_count, cleanup_next_attempt_at)
		SELECT $1, $2, $3, id, blob_key, file_name, kind, mime_type, byte_size,
		       claims_version, $1::uuid::text, checksum_sha256, 1,
		       now() - interval '31 minutes', now() - interval '1 minute',
		       'finalized', now() - interval '91 minutes', now(),
		       1, now() - interval '1 minute'
		FROM creation_reference_materials WHERE id = $4`, cleanupID, creator, sessionID, materialID); err != nil {
		t.Fatalf("seed cleanup fact: %v", err)
	}
	t.Cleanup(func() {
		cleanup, err := pgxpool.New(context.Background(), ownerURL)
		if err != nil {
			t.Errorf("connect cleanup pool: %v", err)
			return
		}
		defer cleanup.Close()
		if _, err := cleanup.Exec(context.Background(), `DELETE FROM creation_reference_material_uploads WHERE id = $1`, cleanupID); err != nil {
			t.Errorf("delete cleanup fact: %v", err)
		}
	})
	if _, err := owner.Exec(ctx, `UPDATE creation_reference_materials SET removed_at = now() WHERE id = $1`, materialID); err != nil {
		t.Fatalf("mark legacy removal: %v", err)
	}
	tx, err := runtime.Begin(ctx)
	if err != nil {
		t.Fatalf("begin recovery: %v", err)
	}
	defer tx.Rollback(ctx)
	if restored, err := NewMaterialRepository(runtime).ConfirmLegacyObject(ctx, tx, materialID); err != nil || !restored {
		t.Fatalf("restore legacy material: restored=%t err=%v", restored, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit recovery: %v", err)
	}
	var active, due bool
	if err := owner.QueryRow(ctx, `SELECT removed_at IS NULL FROM creation_reference_materials WHERE id = $1`, materialID).Scan(&active); err != nil || !active {
		t.Fatalf("legacy material not restored: active=%t err=%v", active, err)
	}
	if err := owner.QueryRow(ctx, `SELECT cleanup_next_attempt_at IS NOT NULL
		FROM creation_reference_material_uploads WHERE id = $1`, cleanupID).Scan(&due); err != nil || due {
		t.Fatalf("restored material still has due cleanup: due=%t err=%v", due, err)
	}
}

func fixtureRetainedMaterial(t *testing.T, pool *pgxpool.Pool, sessionID domain.UUID) domain.UUID {
	t.Helper()
	id := domain.NewUUID()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO creation_reference_materials
		(id, session_id, kind, file_name, mime_type, byte_size, checksum_sha256, blob_key,
		 width_px, height_px, pixel_count)
		VALUES ($1, $2, 'image', 'fixture.png', 'image/png', 1,
		        decode(repeat('00', 32), 'hex'), $3, 1, 1, 1)`, id, sessionID, id.String()); err != nil {
		t.Fatalf("seed reference material: %v", err)
	}
	return id
}
