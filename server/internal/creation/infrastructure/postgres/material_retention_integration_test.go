package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
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
		// V1 has no task-delete command; the owner exercises its future cascade seam.
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
	due, err := uploads.LockDueCleanups(ctx, tx, cleanupAt, 10)
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
