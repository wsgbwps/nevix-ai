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
	assets, next, err := repo.ListVisible(ctx, creator, domain.AssetListFilter{
		MediaType: pointerTo(domain.MediaImage), Sort: domain.AssetNewest,
	}, nil, 1)
	if err != nil || len(assets) != 1 || next == nil || assets[0].CreatorDisplayName != "Asset Search Creator" {
		t.Fatalf("visible first page = %+v next=%+v error=%v", assets, next, err)
	}
	second, end, err := repo.ListVisible(ctx, creator, domain.AssetListFilter{
		MediaType: pointerTo(domain.MediaImage), Sort: domain.AssetNewest,
	}, next, 1)
	if err != nil || len(second) != 1 || end != nil || second[0].ID == assets[0].ID {
		t.Fatalf("visible second page = %+v next=%+v error=%v", second, end, err)
	}
	byID, _, err := repo.ListVisible(ctx, creator, domain.AssetListFilter{Sort: domain.AssetNewest, Search: visibleID.String()}, nil, 1)
	if err != nil || len(byID) != 1 || byID[0].ID != visibleID {
		t.Fatalf("exact asset search = %+v error=%v", byID, err)
	}
	for _, hiddenID := range []domain.UUID{restrictedID, deletedID} {
		if _, err := repo.GetVisible(ctx, creator, hiddenID); !errors.Is(err, domain.ErrAssetNotFound) {
			t.Fatalf("hidden asset %s error=%v, want ErrAssetNotFound", hiddenID, err)
		}
	}
	if _, err := owner.Exec(ctx, `UPDATE creation_sessions SET deleted_at = now() WHERE id = $1`, sessionID); err != nil {
		t.Fatalf("delete source session: %v", err)
	}
	asset, err := repo.GetVisible(ctx, creator, visibleID)
	if err != nil {
		t.Fatalf("asset survives source deletion: %v", err)
	}
	origin, err := repo.GetPrivateOrigin(ctx, asset)
	if err != nil || origin == nil || origin.SessionID != sessionID || origin.TaskID != taskID {
		t.Fatalf("private origin after session deletion = %+v, error=%v", origin, err)
	}

	runner := writetx.New(runtime)
	if err := runner.Run(ctx, func(sc domain.WriteScope) error {
		return repo.SoftDelete(ctx, sc.Tx(), domain.NewUUID(), restrictedID, true)
	}); err != nil {
		t.Fatalf("admin soft delete restricted asset: %v", err)
	}
	var restrictedDeleted bool
	if err := owner.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM creation_media_assets WHERE id = $1`, restrictedID).Scan(&restrictedDeleted); err != nil || !restrictedDeleted {
		t.Fatalf("restricted admin delete persisted=%v err=%v", restrictedDeleted, err)
	}
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
	if _, err := repo.GetVisible(ctx, creator, visibleID); !errors.Is(err, domain.ErrAssetNotFound) {
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
	planCreator := "Publication Plan " + domain.NewUUID().String()
	if _, err := owner.Exec(ctx, `UPDATE users SET display_name = $2 WHERE id = $1`, creator, planCreator); err != nil {
		t.Fatalf("name plan creator: %v", err)
	}
	sessionID := fixtureSession(t, ownerURL, owner, creator)
	tx, err := owner.Begin(ctx)
	if err != nil {
		t.Fatalf("begin plan fixture: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO creation_sessions (owner_user_id, name, created_at, updated_at)
		SELECT $1, 'plan-session-' || series,
		       now() - (series * interval '1 millisecond'), now()
		FROM generate_series(1, 1000) AS series`, creator); err != nil {
		t.Fatalf("seed 1k sessions: %v", err)
	}
	if _, err := tx.Exec(ctx, `ANALYZE creation_sessions`); err != nil {
		t.Fatalf("analyze sessions: %v", err)
	}
	var sessionCursorTime time.Time
	var sessionCursorID domain.UUID
	if err := tx.QueryRow(ctx, `
		SELECT created_at, id FROM creation_sessions
		WHERE owner_user_id = $1 AND deleted_at IS NULL
		ORDER BY created_at DESC, id DESC OFFSET 500 LIMIT 1`, creator).Scan(&sessionCursorTime, &sessionCursorID); err != nil {
		t.Fatalf("load deep session cursor fixture: %v", err)
	}
	var planJSON []byte
	if err := tx.QueryRow(ctx, `
		EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
		SELECT id FROM creation_sessions
		WHERE owner_user_id = $1 AND deleted_at IS NULL
		  AND (created_at, id) < ($2, $3)
		ORDER BY created_at DESC, id DESC LIMIT 31`, creator, sessionCursorTime, sessionCursorID).Scan(&planJSON); err != nil {
		t.Fatalf("explain 1k session keyset page: %v", err)
	}
	var plan any
	if err := json.Unmarshal(planJSON, &plan); err != nil {
		t.Fatalf("decode session plan: %v", err)
	}
	if hasSequentialRelationScan(plan, "creation_sessions") || !planUsesIndex(plan, "creation_sessions_active_listing_idx") {
		t.Fatalf("1k session keyset page missed its partial index: %s", planJSON)
	}
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
	if _, err := tx.Exec(ctx, `
		INSERT INTO creation_generation_queue (task_id, media_type, run_after)
		SELECT id, media_type, now() - interval '1 second'
		FROM creation_generation_tasks
		WHERE idempotency_key LIKE $1 || '-%'
		ORDER BY id LIMIT 10000`, prefix); err != nil {
		t.Fatalf("seed 10k queue rows: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO creation_generation_reservations (task_id, owner_user_id, media_type, released_at)
		SELECT id, owner_user_id, media_type,
		       CASE WHEN row_number() OVER (ORDER BY id) <= 9000 THEN now() END
		FROM creation_generation_tasks
		WHERE idempotency_key LIKE $1 || '-%'
		ORDER BY id LIMIT 10000`, prefix); err != nil {
		t.Fatalf("seed 10k governance reservations: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO creation_generation_attempts (user_id, attempted_at)
		SELECT $1, CASE WHEN series <= 9900 THEN now() - interval '2 minutes' ELSE now() END
		FROM generate_series(1, 10000) AS series`, creator); err != nil {
		t.Fatalf("seed 10k governance attempts: %v", err)
	}
	for _, relation := range []string{"creation_generation_queue", "creation_generation_reservations", "creation_generation_attempts", "creation_generation_tasks"} {
		if _, err := tx.Exec(ctx, `ANALYZE `+relation); err != nil {
			t.Fatalf("analyze %s: %v", relation, err)
		}
	}
	if err := tx.QueryRow(ctx, `
		EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
		UPDATE creation_generation_queue SET
			lease_owner = 'plan-worker', lease_until = now() + interval '30 seconds',
			attempts = attempts + 1, updated_at = now()
		WHERE id = (
			SELECT id FROM creation_generation_queue
			WHERE run_after <= now() AND attempts < max_attempts
			  AND (lease_until IS NULL OR lease_until <= now())
			ORDER BY run_after, id LIMIT 1 FOR UPDATE SKIP LOCKED
		)
		RETURNING id`).Scan(&planJSON); err != nil {
		t.Fatalf("explain 10k queue claim: %v", err)
	}
	if err := json.Unmarshal(planJSON, &plan); err != nil {
		t.Fatalf("decode queue claim plan: %v", err)
	}
	if hasSequentialRelationScan(plan, "creation_generation_queue") || !planUsesIndex(plan, "creation_generation_queue_claim_idx") {
		t.Fatalf("10k queue claim missed its claim index: %s", planJSON)
	}
	governancePlans := []struct {
		name     string
		relation string
		indexes  []string
		query    string
		args     []any
	}{
		{"monthly tasks", "creation_generation_tasks", []string{"creation_generation_tasks_owner_created_idx", "creation_generation_tasks_created_idx"}, `SELECT count(*) FROM creation_generation_tasks WHERE owner_user_id = $1 AND created_at >= now() - interval '2 seconds'`, []any{creator}},
		{"rolling attempts", "creation_generation_attempts", []string{"creation_generation_attempts_user_time_idx", "creation_generation_attempts_time_idx"}, `SELECT count(*) FROM creation_generation_attempts WHERE user_id = $1 AND attempted_at >= now() - interval '1 minute'`, []any{creator}},
		{"active reservations", "creation_generation_reservations", []string{"creation_generation_reservations_active_idx"}, `SELECT count(*) FROM creation_generation_reservations WHERE owner_user_id = $1 AND media_type = 'image' AND released_at IS NULL`, []any{creator}},
	}
	for _, check := range governancePlans {
		if err := tx.QueryRow(ctx, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) `+check.query, check.args...).Scan(&planJSON); err != nil {
			t.Fatalf("explain %s: %v", check.name, err)
		}
		if err := json.Unmarshal(planJSON, &plan); err != nil {
			t.Fatalf("decode %s plan: %v", check.name, err)
		}
		if hasSequentialRelationScan(plan, check.relation) || !planUsesAnyIndex(plan, check.indexes) {
			t.Fatalf("%s missed %v: %s", check.name, check.indexes, planJSON)
		}
	}
	var cursorTime time.Time
	var cursorID domain.UUID
	if err := tx.QueryRow(ctx, `
		SELECT created_at, id FROM creation_media_assets
		WHERE owner_user_id = $1 AND deleted_at IS NULL
		  AND (restricted_at IS NULL OR restriction_released_at IS NOT NULL)
		ORDER BY created_at DESC, id DESC OFFSET 25000 LIMIT 1`, creator).Scan(&cursorTime, &cursorID); err != nil {
		t.Fatalf("load deep cursor fixture: %v", err)
	}
	if err := tx.QueryRow(ctx, `
		EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
		SELECT a.id, u.display_name FROM creation_media_assets a
		JOIN users u ON u.id = a.owner_user_id
		WHERE a.owner_user_id = $3 AND a.deleted_at IS NULL
		  AND (a.restricted_at IS NULL OR a.restriction_released_at IS NOT NULL)
		  AND a.media_type = 'image'
		  AND (a.created_at, a.id) < ($1, $2)
		ORDER BY a.created_at DESC, a.id DESC LIMIT 31`, cursorTime, cursorID, creator).Scan(&planJSON); err != nil {
		t.Fatalf("explain keyset asset page: %v", err)
	}
	if err := json.Unmarshal(planJSON, &plan); err != nil {
		t.Fatalf("decode plan: %v", err)
	}
	if hasSequentialAssetScan(plan) {
		t.Fatalf("50k keyset page used a sequential creation_media_assets scan: %s", planJSON)
	}
	if !planUsesAnyIndex(plan, []string{
		"creation_media_assets_visible_owner_media_created_idx",
		"creation_media_assets_visible_media_created_idx",
		"creation_media_assets_admin_media_created_idx",
	}) {
		t.Fatalf("50k owner page missed production composite index: %s", planJSON)
	}
	if err := tx.QueryRow(ctx, `
		EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
		SELECT a.id FROM creation_media_assets a
		WHERE a.deleted_at IS NULL AND a.media_type = 'image'
		  AND (a.created_at, a.id) < ($1, $2)
		ORDER BY a.created_at DESC, a.id DESC LIMIT 31`, cursorTime, cursorID).Scan(&planJSON); err != nil {
		t.Fatalf("explain admin keyset asset page: %v", err)
	}
	if err := json.Unmarshal(planJSON, &plan); err != nil {
		t.Fatalf("decode admin plan: %v", err)
	}
	if hasSequentialRelationScan(plan, "creation_media_assets") {
		t.Fatalf("50k admin keyset page used a sequential asset scan: %s", planJSON)
	}
	if !planUsesIndex(plan, "creation_media_assets_admin_media_created_idx") {
		t.Fatalf("50k admin page missed production composite index: %s", planJSON)
	}
	publicationPrefix := "publication-plan-" + domain.NewUUID().String()
	if _, err := tx.Exec(ctx, `
		INSERT INTO creation_team_publications (
			source_asset_id, publisher_user_id, publisher_display_name, idempotency_key,
			media_type, mime, blob_key, byte_size, checksum, specification, published_at
		)
		SELECT asset.id, asset.owner_user_id, $3,
		       $1 || '-' || row_number() OVER (ORDER BY asset.created_at, asset.id),
		       asset.media_type, asset.mime, asset.blob_key, asset.byte_size, asset.checksum,
		       '{}'::jsonb, asset.created_at
		FROM creation_media_assets asset
		WHERE asset.owner_user_id = $2 AND asset.deleted_at IS NULL
		ORDER BY asset.created_at, asset.id LIMIT 10000`, publicationPrefix, creator, planCreator); err != nil {
		t.Fatalf("seed 10k publications: %v", err)
	}
	if _, err := tx.Exec(ctx, `ANALYZE creation_team_publications`); err != nil {
		t.Fatalf("analyze publications: %v", err)
	}
	var publicationCursorTime time.Time
	var publicationCursorID domain.UUID
	if err := tx.QueryRow(ctx, `
		SELECT published_at, id FROM creation_team_publications
		WHERE withdrawn_at IS NULL AND restricted_at IS NULL
		ORDER BY published_at DESC, id DESC OFFSET 5000 LIMIT 1`).Scan(&publicationCursorTime, &publicationCursorID); err != nil {
		t.Fatalf("load deep publication cursor: %v", err)
	}
	if err := tx.QueryRow(ctx, `
		EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
		SELECT p.id FROM creation_team_publications p
		JOIN creation_media_assets a ON a.id = p.source_asset_id
		WHERE p.withdrawn_at IS NULL AND p.restricted_at IS NULL
		  AND (a.restricted_at IS NULL OR a.restriction_released_at IS NOT NULL)
		  AND (p.published_at, p.id) < ($1, $2)
		ORDER BY p.published_at DESC, p.id DESC LIMIT 31`, publicationCursorTime, publicationCursorID).Scan(&planJSON); err != nil {
		t.Fatalf("explain publication keyset page: %v", err)
	}
	if err := json.Unmarshal(planJSON, &plan); err != nil {
		t.Fatalf("decode publication plan: %v", err)
	}
	if hasSequentialRelationScan(plan, "creation_team_publications") {
		t.Fatalf("10k deep publication page used a sequential scan: %s", planJSON)
	}
	if !planUsesAnyIndex(plan, []string{
		"creation_team_publications_active_created_idx",
		"creation_team_publications_nonwithdrawn_created_idx",
	}) {
		t.Fatalf("10k member page missed a compatible production keyset index: %s", planJSON)
	}

	repo := &TeamPublicationRepository{pool: tx}
	filter := domain.AssetListFilter{Creator: planCreator, Sort: domain.AssetNewest}
	assertInspirationPages(t, ctx, repo, false, filter, "publication", 10000)
	assertInspirationPages(t, ctx, repo, true, filter, "asset", 50000)
	if _, err := tx.Exec(ctx, `
		UPDATE creation_media_assets asset
		SET deleted_at = now()
		FROM creation_team_publications publication
		WHERE publication.source_asset_id = asset.id
		  AND publication.idempotency_key LIKE $1 || '-%'`, publicationPrefix); err != nil {
		t.Fatalf("delete 10k publication source assets: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE creation_team_publications
		SET restricted_at = now(), direct_restricted_at = now()
		WHERE idempotency_key LIKE $1 || '-%'`, publicationPrefix); err != nil {
		t.Fatalf("restrict 10k deleted-source publications: %v", err)
	}
	for _, relation := range []string{"creation_media_assets", "creation_team_publications"} {
		if _, err := tx.Exec(ctx, `ANALYZE `+relation); err != nil {
			t.Fatalf("analyze restricted %s: %v", relation, err)
		}
	}
	if err := tx.QueryRow(ctx, `
		SELECT p.published_at, p.id FROM creation_team_publications p
		JOIN creation_media_assets a ON a.id = p.source_asset_id
		WHERE p.withdrawn_at IS NULL AND a.deleted_at IS NOT NULL
		  AND (p.restricted_at IS NULL OR
		    (p.direct_restricted_at IS NOT NULL AND p.direct_restriction_released_at IS NULL))
		ORDER BY p.published_at DESC, p.id DESC OFFSET 5000 LIMIT 1`).Scan(&publicationCursorTime, &publicationCursorID); err != nil {
		t.Fatalf("load deep restricted admin publication cursor: %v", err)
	}
	if err := tx.QueryRow(ctx, `
		EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
		SELECT p.id FROM creation_team_publications p
		JOIN creation_media_assets a ON a.id = p.source_asset_id
		WHERE p.withdrawn_at IS NULL AND a.deleted_at IS NOT NULL
		  AND (p.restricted_at IS NULL OR
		    (p.direct_restricted_at IS NOT NULL AND p.direct_restriction_released_at IS NULL))
		  AND (p.published_at, p.id) < ($1, $2)
		ORDER BY p.published_at DESC, p.id DESC LIMIT 31`, publicationCursorTime, publicationCursorID).Scan(&planJSON); err != nil {
		t.Fatalf("explain restricted admin publication keyset page: %v", err)
	}
	if err := json.Unmarshal(planJSON, &plan); err != nil {
		t.Fatalf("decode restricted admin publication plan: %v", err)
	}
	for _, relation := range []string{"creation_team_publications", "creation_media_assets"} {
		if hasSequentialRelationScan(plan, relation) {
			t.Fatalf("10k restricted admin publication page used sequential %s scan: %s", relation, planJSON)
		}
	}
	if !planUsesIndex(plan, "creation_team_publications_nonwithdrawn_created_idx") {
		t.Fatalf("10k restricted admin page missed nonwithdrawn index: %s", planJSON)
	}
	for _, index := range []string{
		"creation_media_assets_task_slot_unique",
		"creation_media_assets_owner_idx",
		"creation_media_assets_visible_created_idx",
		"creation_media_assets_visible_media_created_idx",
		"creation_media_assets_visible_owner_created_idx",
		"creation_media_assets_visible_owner_media_created_idx",
		"creation_media_assets_admin_created_idx",
		"creation_media_assets_admin_media_created_idx",
		"creation_team_publications_active_created_idx",
		"creation_team_publications_active_media_created_idx",
		"creation_team_publications_publisher_fk_idx",
		"creation_team_publications_asset_fk_idx",
		"creation_team_publications_active_asset_idx",
		"creation_team_publications_nonwithdrawn_created_idx",
		"creation_team_publication_references_blob_key_idx",
		"creation_publication_similar_operations_publication_fk_idx",
		"creation_publication_similar_operations_session_fk_idx",
	} {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT to_regclass('public.' || $1) IS NOT NULL`, index).Scan(&exists); err != nil || !exists {
			t.Fatalf("required Asset/FK query index %s exists=%v error=%v", index, exists, err)
		}
	}
}

func hasSequentialAssetScan(value any) bool {
	return hasSequentialRelationScan(value, "creation_media_assets")
}

func hasSequentialRelationScan(value any, relation string) bool {
	switch node := value.(type) {
	case []any:
		for _, child := range node {
			if hasSequentialRelationScan(child, relation) {
				return true
			}
		}
	case map[string]any:
		if node["Node Type"] == "Seq Scan" && node["Relation Name"] == relation {
			return true
		}
		for _, child := range node {
			if hasSequentialRelationScan(child, relation) {
				return true
			}
		}
	}
	return false
}

func planUsesIndex(value any, index string) bool {
	switch node := value.(type) {
	case []any:
		for _, child := range node {
			if planUsesIndex(child, index) {
				return true
			}
		}
	case map[string]any:
		if node["Index Name"] == index {
			return true
		}
		for _, child := range node {
			if planUsesIndex(child, index) {
				return true
			}
		}
	}
	return false
}

func planUsesAnyIndex(value any, indexes []string) bool {
	for _, index := range indexes {
		if planUsesIndex(value, index) {
			return true
		}
	}
	return false
}

func assertInspirationPages(t *testing.T, ctx context.Context, repo *TeamPublicationRepository, admin bool, filter domain.AssetListFilter, itemType string, want int) {
	t.Helper()
	seen := make(map[domain.UUID]struct{}, want)
	var cursor *domain.CompoundCursor
	for page := 0; ; page++ {
		items, next, err := repo.ListInspiration(ctx, admin, filter, cursor, 2000)
		if err != nil {
			t.Fatalf("list production inspiration page %d: %v", page, err)
		}
		for _, item := range items {
			var id domain.UUID
			switch itemType {
			case "asset":
				if item.Type != itemType || item.Asset == nil || item.Publication != nil {
					t.Fatalf("admin production item %d has wrong projection: %+v", page, item)
				}
				id = item.Asset.ID
			case "publication":
				if item.Type != itemType || item.Publication == nil || item.Asset != nil {
					t.Fatalf("member production item %d has wrong projection: %+v", page, item)
				}
				id = item.Publication.ID
			}
			if _, duplicate := seen[id]; duplicate {
				t.Fatalf("production cursor duplicated %s %s", itemType, id)
			}
			seen[id] = struct{}{}
		}
		if next == nil {
			break
		}
		if len(items) == 0 {
			t.Fatalf("production cursor returned an empty non-terminal page %d", page)
		}
		cursor = next
	}
	if len(seen) != want {
		t.Fatalf("production %s cursor returned %d unique rows, want %d", itemType, len(seen), want)
	}
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
