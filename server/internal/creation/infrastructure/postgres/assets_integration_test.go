package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
	"github.com/nevix-ai/server/internal/creation/infrastructure/writetx"
	"github.com/nevix-ai/server/internal/migration"
)

// Package-local real-database coverage for the media-asset formation SQL
// (spec #150 Asset 唯一性, issue #160): the (task_id, slot_index) unique
// constraint is the durable backstop behind the idempotent insert, a
// repeated formation never duplicates the aggregate, and identity_app holds
// no UPDATE grant for the immutable formation facts. Runs only under the
// dedicated Creation integration harness; requested runs must not skip.
func TestMediaAssetFormationIsUniquePerTaskSlot(t *testing.T) {
	ownerURL, runtimeURL := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	pool, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect identity_app pool: %v", err)
	}
	defer pool.Close()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner pool: %v", err)
	}
	defer owner.Close()

	creator := fixtureUser(t, ownerURL)
	sessionID := fixtureSession(t, ownerURL, owner, creator)
	taskID := fixtureGenerationTask(t, ownerURL, owner, creator, sessionID)

	repo := NewMediaAssetRepository(pool)
	runner := writetx.New(pool)
	formation := domain.MediaAssetFormation{
		OwnerID: creator, TaskID: taskID, SlotIndex: 0, MediaType: domain.MediaImage,
		Mime: "image/png", BlobKey: "generation-results/fixture/slot-0", ByteSize: 128,
		Checksum: []byte("0123456789abcdef0123456789abcdef"),
	}

	created := false
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		var err error
		created, err = repo.InsertMediaAsset(ctx, sc.Tx(), formation)
		return err
	}); err != nil || !created {
		t.Fatalf("first formation must create: created=%v err=%v", created, err)
	}

	// A repeated formation (repeated poll, worker completion, crash recovery)
	// lands on the unique constraint and reports created=false.
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		var err error
		created, err = repo.InsertMediaAsset(ctx, sc.Tx(), formation)
		return err
	}); err != nil || created {
		t.Fatalf("repeat formation must be a no-op: created=%v err=%v", created, err)
	}
	if got := countAssets(t, owner, taskID); got != 1 {
		t.Fatalf("one asset row expected, got %d", got)
	}

	// The database constraint itself rejects a second slot-0 asset written
	// around the repository.
	_, err = owner.Exec(ctx, `
		INSERT INTO creation_media_assets
			(owner_user_id, task_id, slot_index, media_type, mime, blob_key, byte_size, checksum)
		VALUES ($1, $2, 0, 'image', 'image/png', 'generation-results/fixture/other', 128, $3)`,
		creator, taskID, []byte("0123456789abcdef0123456789abcdef"))
	if err == nil {
		t.Fatal("database accepted a second asset for one slot")
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		t.Fatalf("second asset error must be the unique violation, got %v", err)
	}

	// Immutable formation facts: identity_app holds no UPDATE grant.
	err = runner.Run(ctx, func(sc domain.WriteScope) error {
		_, err := sc.Tx().Exec(ctx, `UPDATE creation_media_assets SET byte_size = 1 WHERE task_id = $1`, taskID)
		return err
	})
	if err == nil {
		t.Fatal("identity_app must not hold the asset UPDATE grant")
	}
}

func countAssets(t *testing.T, pool *pgxpool.Pool, taskID domain.UUID) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM creation_media_assets WHERE task_id = $1`, taskID).Scan(&count); err != nil {
		t.Fatalf("count assets: %v", err)
	}
	return count
}

// fixtureSession seeds one private session the task FK can point at. The
// cleanup opens its own pool: the test function's pools are already closed
// by the time t.Cleanup runs.
func fixtureSession(t *testing.T, ownerURL string, pool *pgxpool.Pool, owner domain.UUID) domain.UUID {
	t.Helper()
	id := domain.NewUUID()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO creation_sessions (id, owner_user_id, name) VALUES ($1, $2, 'asset-fixture')`,
		id, owner); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	t.Cleanup(func() {
		cleanup, err := pgxpool.New(context.Background(), ownerURL)
		if err != nil {
			t.Logf("open session cleanup pool: %v", err)
			return
		}
		defer cleanup.Close()
		if _, err := cleanup.Exec(context.Background(), `DELETE FROM creation_sessions WHERE id = $1`, id); err != nil {
			t.Logf("cleanup session: %v", err)
		}
	})
	return id
}

// fixtureGenerationTask seeds one terminal-ready task row.
func fixtureGenerationTask(t *testing.T, ownerURL string, pool *pgxpool.Pool, owner, sessionID domain.UUID) domain.UUID {
	t.Helper()
	id := domain.NewUUID()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO creation_generation_tasks
			(id, session_id, owner_user_id, idempotency_key, payload_hash, media_type,
			 specification, manifest_version, draft_revision, slot_count)
		VALUES ($1, $2, $3, $4, $5, 'image', '{}', 1, now(), 1)`,
		id, sessionID, owner, "fixture-"+id.String(), "fixture-hash"); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	t.Cleanup(func() {
		cleanup, err := pgxpool.New(context.Background(), ownerURL)
		if err != nil {
			t.Logf("open task cleanup pool: %v", err)
			return
		}
		defer cleanup.Close()
		// The asset keeps no cascade to its origin: clean it first.
		if _, err := cleanup.Exec(context.Background(),
			`DELETE FROM creation_media_assets WHERE task_id = $1`, id); err != nil {
			t.Logf("cleanup assets: %v", err)
		}
		if _, err := cleanup.Exec(context.Background(), `DELETE FROM creation_generation_tasks WHERE id = $1`, id); err != nil {
			t.Logf("cleanup task: %v", err)
		}
	})
	return id
}
