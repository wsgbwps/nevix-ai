package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

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

func TestAssetLibraryVisibilitySearchOriginAndDeleteAuthorization(t *testing.T) {
	ownerURL, runtimeURL := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	runtime, err := pgxpool.New(ctx, runtimeURL)
	if err != nil {
		t.Fatalf("connect identity_app pool: %v", err)
	}
	defer runtime.Close()
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner pool: %v", err)
	}
	defer owner.Close()

	creator := fixtureUser(t, ownerURL)
	if _, err := owner.Exec(ctx, `UPDATE users SET display_name = 'Asset Search Creator' WHERE id = $1`, creator); err != nil {
		t.Fatalf("name creator: %v", err)
	}
	sessionID := fixtureSession(t, ownerURL, owner, creator)
	taskID := fixtureGenerationTask(t, ownerURL, owner, creator, sessionID)
	checksum := []byte("0123456789abcdef0123456789abcdef")
	var visibleID, restrictedID, deletedID domain.UUID
	for slot, state := range []string{"visible", "visible", "restricted", "deleted"} {
		id := domain.NewUUID()
		_, err := owner.Exec(ctx, `
			INSERT INTO creation_media_assets
				(id, owner_user_id, task_id, slot_index, media_type, mime, blob_key, byte_size, checksum,
				 restricted_at, deleted_at, created_at)
			VALUES ($1, $2, $3, $4::smallint, 'image', 'image/png', $5, 128, $6,
				 CASE WHEN $7 = 'restricted' THEN now() END,
				 CASE WHEN $7 = 'deleted' THEN now() END,
				 now() + ($4::smallint * interval '1 second'))`,
			id, creator, taskID, slot, "generation-results/asset-library/"+id.String(), checksum, state)
		if err != nil {
			t.Fatalf("seed %s asset: %v", state, err)
		}
		switch state {
		case "visible":
			if visibleID == (domain.UUID{}) {
				visibleID = id
			}
		case "restricted":
			restrictedID = id
		case "deleted":
			deletedID = id
		}
	}

	repo := NewMediaAssetRepository(runtime)
	assets, next, err := repo.ListVisible(ctx, domain.AssetListFilter{
		MediaType: pointerTo(domain.MediaImage), Sort: domain.AssetNewest, Creator: "aSSeT sEAR",
	}, nil, 1)
	if err != nil || len(assets) != 1 || next == nil || assets[0].CreatorDisplayName != "Asset Search Creator" {
		t.Fatalf("visible first page = %+v next=%+v error=%v", assets, next, err)
	}
	second, end, err := repo.ListVisible(ctx, domain.AssetListFilter{
		MediaType: pointerTo(domain.MediaImage), Sort: domain.AssetNewest, Creator: "aSSeT sEAR",
	}, next, 1)
	if err != nil || len(second) != 1 || end != nil || second[0].ID == assets[0].ID {
		t.Fatalf("visible second page = %+v next=%+v error=%v", second, end, err)
	}
	byID, _, err := repo.ListVisible(ctx, domain.AssetListFilter{Sort: domain.AssetNewest, Search: visibleID.String()}, nil, 1)
	if err != nil || len(byID) != 1 || byID[0].ID != visibleID {
		t.Fatalf("exact asset search = %+v error=%v", byID, err)
	}
	for _, hiddenID := range []domain.UUID{restrictedID, deletedID} {
		if _, err := repo.GetVisible(ctx, hiddenID); !errors.Is(err, domain.ErrAssetNotFound) {
			t.Fatalf("hidden asset %s error=%v, want ErrAssetNotFound", hiddenID, err)
		}
	}
	if _, err := owner.Exec(ctx, `UPDATE creation_sessions SET deleted_at = now() WHERE id = $1`, sessionID); err != nil {
		t.Fatalf("delete source session: %v", err)
	}
	asset, err := repo.GetVisible(ctx, visibleID)
	if err != nil {
		t.Fatalf("asset survives source deletion: %v", err)
	}
	origin, err := repo.GetPrivateOrigin(ctx, asset)
	if err != nil || origin == nil || origin.SessionID != sessionID || origin.TaskID != taskID {
		t.Fatalf("private origin after session deletion = %+v, error=%v", origin, err)
	}

	runner := writetx.New(runtime)
	err = runner.Run(ctx, func(sc domain.WriteScope) error {
		return repo.SoftDelete(ctx, sc.Tx(), domain.NewUUID(), visibleID, false)
	})
	if !errors.Is(err, domain.ErrAssetNotFound) {
		t.Fatalf("foreign member delete error=%v, want ErrAssetNotFound", err)
	}
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		return repo.SoftDelete(ctx, sc.Tx(), domain.NewUUID(), visibleID, true)
	}); err != nil {
		t.Fatalf("admin soft delete: %v", err)
	}
	if _, err := repo.GetVisible(ctx, visibleID); !errors.Is(err, domain.ErrAssetNotFound) {
		t.Fatalf("soft-deleted asset error=%v, want ErrAssetNotFound", err)
	}
}

func TestAssetLibraryQueryPlanAtFiftyThousandRows(t *testing.T) {
	ownerURL, _ := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	owner, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Fatalf("connect owner pool: %v", err)
	}
	defer owner.Close()
	creator := fixtureUser(t, ownerURL)
	sessionID := fixtureSession(t, ownerURL, owner, creator)
	tx, err := owner.Begin(ctx)
	if err != nil {
		t.Fatalf("begin plan fixture: %v", err)
	}
	defer tx.Rollback(ctx)
	prefix := "asset-plan-" + domain.NewUUID().String()
	if _, err := tx.Exec(ctx, `
		INSERT INTO creation_generation_tasks
			(id, session_id, owner_user_id, idempotency_key, payload_hash, media_type,
			 specification, manifest_version, slot_count, created_at, updated_at)
		SELECT gen_random_uuid(), $1, $2, $3 || '-' || series, 'plan-hash', 'image',
		       '{}'::jsonb, 1, 4, now() - (series * interval '1 millisecond'), now()
		FROM generate_series(1, 12500) AS series`, sessionID, creator, prefix); err != nil {
		t.Fatalf("seed plan tasks: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO creation_media_assets
			(owner_user_id, task_id, slot_index, media_type, mime, blob_key, byte_size, checksum, created_at)
		SELECT $1, task.id, slot, 'image', 'image/png',
		       'generation-results/plan/' || task.id || '-' || slot, 128,
		       decode('3031323334353637383961626364656630313233343536373839616263646566', 'hex'),
		       task.created_at + (slot * interval '1 microsecond')
		FROM creation_generation_tasks task CROSS JOIN generate_series(0, 3) AS slot
		WHERE task.idempotency_key LIKE $2 || '-%'`, creator, prefix); err != nil {
		t.Fatalf("seed 50k assets: %v", err)
	}
	if _, err := tx.Exec(ctx, `ANALYZE creation_media_assets`); err != nil {
		t.Fatalf("analyze assets: %v", err)
	}
	var cursorTime time.Time
	var cursorID domain.UUID
	if err := tx.QueryRow(ctx, `
		SELECT created_at, id FROM creation_media_assets
		WHERE deleted_at IS NULL AND restricted_at IS NULL
		ORDER BY created_at DESC, id DESC OFFSET 25000 LIMIT 1`).Scan(&cursorTime, &cursorID); err != nil {
		t.Fatalf("load deep cursor fixture: %v", err)
	}
	var planJSON []byte
	if err := tx.QueryRow(ctx, `
		EXPLAIN (ANALYZE, FORMAT JSON)
		SELECT a.id, u.display_name FROM creation_media_assets a
		JOIN users u ON u.id = a.owner_user_id
		WHERE a.deleted_at IS NULL AND a.restricted_at IS NULL
		  AND a.media_type = 'image'
		  AND a.owner_user_id IN (
		    SELECT id FROM users WHERE lower(display_name) LIKE $3 ESCAPE '\')
		  AND (a.created_at, a.id) < ($1, $2)
		ORDER BY a.created_at DESC, a.id DESC LIMIT 31`, cursorTime, cursorID, "connection-fixture%").Scan(&planJSON); err != nil {
		t.Fatalf("explain keyset asset page: %v", err)
	}
	var plan any
	if err := json.Unmarshal(planJSON, &plan); err != nil {
		t.Fatalf("decode plan: %v", err)
	}
	if hasSequentialAssetScan(plan) {
		t.Fatalf("50k keyset page used a sequential creation_media_assets scan: %s", planJSON)
	}
	for _, index := range []string{
		"creation_media_assets_task_slot_unique",
		"creation_media_assets_owner_idx",
		"creation_media_assets_visible_created_idx",
		"creation_media_assets_visible_media_created_idx",
		"creation_media_assets_visible_owner_created_idx",
		"creation_media_assets_visible_owner_media_created_idx",
	} {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT to_regclass('public.' || $1) IS NOT NULL`, index).Scan(&exists); err != nil || !exists {
			t.Fatalf("required Asset/FK query index %s exists=%v error=%v", index, exists, err)
		}
	}
}

func hasSequentialAssetScan(value any) bool {
	switch node := value.(type) {
	case []any:
		for _, child := range node {
			if hasSequentialAssetScan(child) {
				return true
			}
		}
	case map[string]any:
		if node["Node Type"] == "Seq Scan" && node["Relation Name"] == "creation_media_assets" {
			return true
		}
		for _, child := range node {
			if hasSequentialAssetScan(child) {
				return true
			}
		}
	}
	return false
}

func pointerTo[T any](value T) *T { return &value }

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
			 specification, manifest_version, slot_count)
		VALUES ($1, $2, $3, $4, $5, 'image', '{}', 1, 1)`,
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
