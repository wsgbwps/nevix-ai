package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
	"github.com/nevix-ai/server/internal/creation/infrastructure/writetx"
	"github.com/nevix-ai/server/internal/migration"
)

func TestPublicationCommandsConvergeUnderConcurrency(t *testing.T) {
	ownerURL, runtimeURL := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	owner := openPublicationPool(t, ctx, ownerURL)
	defer owner.Close()
	runtime := openPublicationPool(t, ctx, runtimeURL)
	defer runtime.Close()
	repo := NewTeamPublicationRepository(runtime)
	runner := writetx.New(runtime)

	for _, scenario := range []struct {
		name string
		key  func(int) string
	}{
		{name: "same key", key: func(int) string { return "publish-same" }},
		{name: "different keys", key: func(index int) string { return fmt.Sprintf("publish-%d", index) }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newPublicationFixture(t, ownerURL, owner, false)
			results := concurrentPublish(ctx, repo, runner, fixture.creator, fixture.assetID, scenario.key, 4)
			ids := make(map[domain.UUID]struct{})
			created := 0
			for _, result := range results {
				if result.err != nil {
					t.Fatalf("concurrent publish: %v", result.err)
				}
				ids[result.publication.ID] = struct{}{}
				if result.created {
					created++
				}
			}
			if len(ids) != 1 || created != 1 {
				t.Fatalf("publish convergence ids=%d created=%d", len(ids), created)
			}
			var rows int
			if err := owner.QueryRow(ctx, `
				SELECT count(*) FROM creation_team_publications
				WHERE source_asset_id = $1 AND withdrawn_at IS NULL AND restricted_at IS NULL`, fixture.assetID).Scan(&rows); err != nil || rows != 1 {
				t.Fatalf("active publication rows=%d err=%v", rows, err)
			}
		})
	}

	t.Run("create similar and withdrawal", func(t *testing.T) {
		actor := fixtureUser(t, ownerURL)
		fixture := newPublicationFixture(t, ownerURL, owner, true)
		publication := publishFixture(t, ctx, repo, runner, fixture.creator, fixture.assetID, "publish-similar")
		results := concurrentCreateSimilar(ctx, repo, runner, actor, publication.ID, "similar-same", 4)
		created := 0
		var expected domain.SimilarCreation
		for index, result := range results {
			if result.err != nil {
				t.Fatalf("concurrent create similar: %v", result.err)
			}
			if result.created {
				created++
			}
			if index == 0 {
				expected = result.similar
				continue
			}
			if result.similar.Session.ID != expected.Session.ID || len(result.similar.Materials) != 1 ||
				result.similar.Materials[0].ID != expected.Materials[0].ID {
				t.Fatalf("same-key replay diverged: first=%+v replay=%+v", expected, result.similar)
			}
		}
		if created != 1 || len(expected.Materials) != 1 {
			t.Fatalf("create similar convergence created=%d materials=%d", created, len(expected.Materials))
		}
		assertSimilarOperationAtomic(t, ctx, owner, actor, "similar-same", expected)

		withdrawTx, err := runtime.Begin(ctx)
		if err != nil {
			t.Fatalf("begin withdrawal: %v", err)
		}
		defer withdrawTx.Rollback(ctx)
		if err := repo.Withdraw(ctx, withdrawTx, fixture.creator, publication.ID, false); err != nil {
			t.Fatalf("withdraw under lock: %v", err)
		}
		freshTx, err := runtime.Begin(ctx)
		if err != nil {
			t.Fatalf("begin fresh reuse: %v", err)
		}
		defer freshTx.Rollback(ctx)
		var freshPID int
		if err := freshTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&freshPID); err != nil {
			t.Fatalf("read fresh reuse backend: %v", err)
		}
		freshDone := make(chan similarCommandResult, 1)
		go func() {
			result, created, err := repo.CreateSimilar(ctx, freshTx, actor, publication.ID, "similar-fresh")
			freshDone <- similarCommandResult{similar: result, created: created, err: err}
		}()
		waitForDatabaseBlock(t, ctx, owner, freshPID)

		replay, replayCreated, err := runCreateSimilar(ctx, runner, repo, actor, publication.ID, "similar-same")
		if err != nil || replayCreated || replay.Session.ID != expected.Session.ID {
			t.Fatalf("durable replay during withdrawal: created=%v session=%s err=%v", replayCreated, replay.Session.ID, err)
		}
		if err := withdrawTx.Commit(ctx); err != nil {
			t.Fatalf("commit withdrawal: %v", err)
		}
		fresh := <-freshDone
		if !errors.Is(fresh.err, domain.ErrPublicationNotFound) || fresh.created {
			t.Fatalf("fresh reuse after withdrawal: created=%v err=%v", fresh.created, fresh.err)
		}
	})

	t.Run("publication restriction wins before republish", func(t *testing.T) {
		fixture := newPublicationFixture(t, ownerURL, owner, false)
		publication := publishFixture(t, ctx, repo, runner, fixture.creator, fixture.assetID, "publish-before-restriction")
		restrictTx, err := runtime.Begin(ctx)
		if err != nil {
			t.Fatalf("begin restriction: %v", err)
		}
		defer restrictTx.Rollback(ctx)
		if _, changed, err := repo.RestrictPublication(ctx, restrictTx, publication.ID); err != nil || !changed {
			t.Fatalf("restrict publication: changed=%v err=%v", changed, err)
		}

		publishTx, err := runtime.Begin(ctx)
		if err != nil {
			t.Fatalf("begin republish: %v", err)
		}
		defer publishTx.Rollback(ctx)
		var publishPID int
		if err := publishTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&publishPID); err != nil {
			t.Fatalf("read republish backend: %v", err)
		}
		publishDone := make(chan publishCommandResult, 1)
		go func() {
			result, created, err := repo.Publish(ctx, publishTx, fixture.creator, fixture.assetID, "publish-during-restriction")
			publishDone <- publishCommandResult{publication: result, created: created, err: err}
		}()
		waitForDatabaseBlock(t, ctx, owner, publishPID)
		if err := restrictTx.Commit(ctx); err != nil {
			t.Fatalf("commit restriction: %v", err)
		}
		blocked := <-publishDone
		if !errors.Is(blocked.err, domain.ErrAssetNotFound) || blocked.created {
			t.Fatalf("republish after restriction: created=%v err=%v", blocked.created, blocked.err)
		}
		if err := publishTx.Rollback(ctx); err != nil {
			t.Fatalf("rollback blocked republish: %v", err)
		}

		if err := runner.Run(ctx, func(scope domain.WriteScope) error {
			_, _, err := repo.ReleasePublication(ctx, scope.Tx(), publication.ID)
			return err
		}); err != nil {
			t.Fatalf("release publication restriction: %v", err)
		}
		fresh := publishFixture(t, ctx, repo, runner, fixture.creator, fixture.assetID, "publish-after-release")
		if fresh.ID == publication.ID {
			t.Fatal("restriction release restored the terminal publication identity")
		}
	})
}

func TestPublicationProjectionAndFinalRetention(t *testing.T) {
	ownerURL, runtimeURL := requireIntegrationEnv(t)
	ctx := context.Background()
	if _, err := migration.Apply(ctx, ownerURL); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	owner := openPublicationPool(t, ctx, ownerURL)
	defer owner.Close()
	runtime := openPublicationPool(t, ctx, runtimeURL)
	defer runtime.Close()
	repo := NewTeamPublicationRepository(runtime)
	runner := writetx.New(runtime)

	t.Run("admin sees publication and restriction independently", func(t *testing.T) {
		fixture := newPublicationFixture(t, ownerURL, owner, false)
		publication := publishFixture(t, ctx, repo, runner, fixture.creator, fixture.assetID, "publish-admin-projection")
		if _, err := owner.Exec(ctx, `UPDATE creation_media_assets SET restricted_at = now() WHERE id = $1`, fixture.assetID); err != nil {
			t.Fatalf("restrict asset: %v", err)
		}
		if _, err := owner.Exec(ctx, `UPDATE creation_team_publications SET restricted_at = now() WHERE id = $1`, publication.ID); err != nil {
			t.Fatalf("restrict publication: %v", err)
		}
		items, _, err := repo.ListInspiration(ctx, true, domain.AssetListFilter{Search: fixture.assetID.String(), Sort: domain.AssetNewest}, nil, 10)
		if err != nil || len(items) != 1 || items[0].Asset == nil {
			t.Fatalf("admin restricted projection=%+v err=%v", items, err)
		}
		asset := items[0].Asset
		if !asset.Restricted || asset.ActivePublication == nil || !asset.ActivePublication.Restricted || asset.ActivePublication.ID != publication.ID {
			t.Fatalf("admin projection lost independent state: %+v", asset)
		}
		member, _, err := repo.ListInspiration(ctx, false, domain.AssetListFilter{Search: publication.ID.String(), Sort: domain.AssetNewest}, nil, 10)
		if err != nil || len(member) != 0 {
			t.Fatalf("member saw restricted publication=%+v err=%v", member, err)
		}
		detail, err := repo.GetAdminAsset(ctx, fixture.assetID)
		if err != nil || detail.ActivePublication == nil || !detail.ActivePublication.Restricted {
			t.Fatalf("admin restricted detail=%+v err=%v", detail, err)
		}
	})

	for _, transition := range []string{"withdraw", "restrict"} {
		t.Run(transition+" schedules final material cleanup", func(t *testing.T) {
			fixture := newPublicationFixture(t, ownerURL, owner, true)
			publication := publishFixture(t, ctx, repo, runner, fixture.creator, fixture.assetID, "publish-retention-"+transition)
			cleanupID := seedFinalizedUpload(t, ctx, owner, fixture)
			if err := runner.Run(ctx, func(scope domain.WriteScope) error {
				_, _, err := NewMaterialRepository(runtime).Remove(ctx, scope.Tx(), fixture.creator, fixture.materialID)
				return err
			}); err != nil {
				t.Fatalf("remove source material: %v", err)
			}
			if _, err := owner.Exec(ctx, `DELETE FROM creation_generation_task_references WHERE task_id = $1 AND material_id = $2`, fixture.taskID, fixture.materialID); err != nil {
				t.Fatalf("release task material retention: %v", err)
			}
			assertCleanupDue(t, ctx, owner, cleanupID, false)
			if err := runner.Run(ctx, func(scope domain.WriteScope) error {
				return NewMediaAssetRepository(runtime).SoftDelete(ctx, scope.Tx(), fixture.creator, fixture.assetID, false)
			}); err != nil {
				t.Fatalf("delete source asset: %v", err)
			}
			detail, err := repo.GetPublication(ctx, publication.ID)
			if err != nil || detail.Publication.BlobKey != fixture.resultBlobKey || len(detail.References) != 1 || detail.References[0].BlobKey != fixture.materialBlobKey {
				t.Fatalf("publication retention detail=%+v err=%v", detail, err)
			}
			assertCleanupDue(t, ctx, owner, cleanupID, false)

			switch transition {
			case "withdraw":
				if err := runner.Run(ctx, func(scope domain.WriteScope) error {
					return repo.Withdraw(ctx, scope.Tx(), fixture.creator, publication.ID, false)
				}); err != nil {
					t.Fatalf("withdraw final publication: %v", err)
				}
			case "restrict":
				if err := runner.Run(ctx, func(scope domain.WriteScope) error {
					_, err := scope.Tx().Exec(ctx, `UPDATE creation_team_publications SET restricted_at = now() WHERE id = $1`, publication.ID)
					return err
				}); err != nil {
					t.Fatalf("restrict final publication: %v", err)
				}
			}
			assertCleanupDue(t, ctx, owner, cleanupID, true)
			var attempts int
			if err := owner.QueryRow(ctx, `SELECT cleanup_attempt_count FROM creation_reference_material_uploads WHERE id = $1`, cleanupID).Scan(&attempts); err != nil || attempts != 1 {
				t.Fatalf("terminal cleanup attempts=%d err=%v", attempts, err)
			}
		})
	}
}

type publicationFixture struct {
	creator         domain.UUID
	sessionID       domain.UUID
	taskID          domain.UUID
	assetID         domain.UUID
	materialID      domain.UUID
	materialBlobKey string
	resultBlobKey   string
}

func newPublicationFixture(t *testing.T, ownerURL string, owner *pgxpool.Pool, withReference bool) publicationFixture {
	t.Helper()
	ctx := context.Background()
	fixture := publicationFixture{creator: fixtureUser(t, ownerURL)}
	fixture.sessionID = fixtureSession(t, ownerURL, owner, fixture.creator)
	fixture.taskID = fixtureGenerationTask(t, ownerURL, owner, fixture.creator, fixture.sessionID)
	specification := domain.GenerationSpecification{
		SchemaVersion: domain.SpecificationSchemaVersion, MediaType: domain.MediaImage,
		Prompt: "publication fixture", Model: "fixture-model", Mode: "text",
		ManifestVersion: 1, Quantity: 1, References: []domain.SpecificationReference{},
	}
	if withReference {
		fixture.materialID = fixtureRetainedMaterial(t, owner, fixture.sessionID)
		fixture.materialBlobKey = fixture.materialID.String()
		specification.Mode = "reference-image"
		specification.References = []domain.SpecificationReference{{
			MaterialID: fixture.materialID, Role: domain.DraftRole("reference"),
			Kind: domain.KindImage, ClaimsVersion: 1,
		}}
		if _, err := owner.Exec(ctx, `
			INSERT INTO creation_generation_task_references (task_id, material_id) VALUES ($1, $2)`, fixture.taskID, fixture.materialID); err != nil {
			t.Fatalf("retain publication material: %v", err)
		}
	}
	specificationJSON, err := json.Marshal(specification)
	if err != nil {
		t.Fatalf("encode publication specification: %v", err)
	}
	if _, err := owner.Exec(ctx, `UPDATE creation_generation_tasks SET specification = $2 WHERE id = $1`, fixture.taskID, specificationJSON); err != nil {
		t.Fatalf("set publication specification: %v", err)
	}
	fixture.assetID = domain.NewUUID()
	fixture.resultBlobKey = "generation-results/publication/" + fixture.assetID.String()
	if _, err := owner.Exec(ctx, `
		INSERT INTO creation_media_assets
			(id, owner_user_id, task_id, slot_index, media_type, mime, blob_key, byte_size, checksum)
		VALUES ($1, $2, $3, 0, 'image', 'image/png', $4, 128,
			decode('3031323334353637383961626364656630313233343536373839616263646566', 'hex'))`,
		fixture.assetID, fixture.creator, fixture.taskID, fixture.resultBlobKey); err != nil {
		t.Fatalf("seed publication asset: %v", err)
	}
	t.Cleanup(func() { cleanupPublicationFixture(t, ownerURL, fixture) })
	return fixture
}

func cleanupPublicationFixture(t *testing.T, ownerURL string, fixture publicationFixture) {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, ownerURL)
	if err != nil {
		t.Logf("open publication cleanup pool: %v", err)
		return
	}
	defer pool.Close()
	rows, err := pool.Query(ctx, `
		SELECT operation.session_id FROM creation_publication_similar_operations operation
		JOIN creation_team_publications publication ON publication.id = operation.publication_id
		WHERE publication.source_asset_id = $1`, fixture.assetID)
	if err == nil {
		var sessionIDs []domain.UUID
		for rows.Next() {
			var id domain.UUID
			if rows.Scan(&id) == nil {
				sessionIDs = append(sessionIDs, id)
			}
		}
		rows.Close()
		for _, id := range sessionIDs {
			_, _ = pool.Exec(ctx, `DELETE FROM creation_reference_materials WHERE session_id = $1`, id)
			_, _ = pool.Exec(ctx, `DELETE FROM creation_publication_similar_operations WHERE session_id = $1`, id)
			_, _ = pool.Exec(ctx, `DELETE FROM creation_sessions WHERE id = $1`, id)
		}
	}
	_, _ = pool.Exec(ctx, `DELETE FROM creation_reference_material_uploads WHERE material_id = $1`, fixture.materialID)
	_, _ = pool.Exec(ctx, `DELETE FROM creation_team_publications WHERE source_asset_id = $1`, fixture.assetID)
	_, _ = pool.Exec(ctx, `DELETE FROM creation_media_assets WHERE id = $1`, fixture.assetID)
	_, _ = pool.Exec(ctx, `DELETE FROM creation_generation_tasks WHERE id = $1`, fixture.taskID)
	_, _ = pool.Exec(ctx, `DELETE FROM creation_reference_materials WHERE id = $1`, fixture.materialID)
}

func openPublicationPool(t *testing.T, ctx context.Context, url string) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect publication pool: %v", err)
	}
	return pool
}

func publishFixture(t *testing.T, ctx context.Context, repo *TeamPublicationRepository, runner *writetx.Runner, creator, assetID domain.UUID, key string) domain.TeamPublication {
	t.Helper()
	var publication domain.TeamPublication
	if err := runner.Run(ctx, func(scope domain.WriteScope) error {
		var err error
		publication, _, err = repo.Publish(ctx, scope.Tx(), creator, assetID, key)
		return err
	}); err != nil {
		t.Fatalf("publish fixture: %v", err)
	}
	return publication
}

type publishCommandResult struct {
	publication domain.TeamPublication
	created     bool
	err         error
}

func concurrentPublish(ctx context.Context, repo *TeamPublicationRepository, runner *writetx.Runner, creator, assetID domain.UUID, key func(int) string, count int) []publishCommandResult {
	start := make(chan struct{})
	results := make([]publishCommandResult, count)
	var group sync.WaitGroup
	for index := range results {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			err := runner.Run(ctx, func(scope domain.WriteScope) error {
				var err error
				results[index].publication, results[index].created, err = repo.Publish(ctx, scope.Tx(), creator, assetID, key(index))
				return err
			})
			results[index].err = err
		}()
	}
	close(start)
	group.Wait()
	return results
}

type similarCommandResult struct {
	similar domain.SimilarCreation
	created bool
	err     error
}

func concurrentCreateSimilar(ctx context.Context, repo *TeamPublicationRepository, runner *writetx.Runner, actor, publicationID domain.UUID, key string, count int) []similarCommandResult {
	start := make(chan struct{})
	results := make([]similarCommandResult, count)
	var group sync.WaitGroup
	for index := range results {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			results[index].similar, results[index].created, results[index].err = runCreateSimilar(ctx, runner, repo, actor, publicationID, key)
		}()
	}
	close(start)
	group.Wait()
	return results
}

func runCreateSimilar(ctx context.Context, runner *writetx.Runner, repo *TeamPublicationRepository, actor, publicationID domain.UUID, key string) (domain.SimilarCreation, bool, error) {
	var result domain.SimilarCreation
	var created bool
	err := runner.Run(ctx, func(scope domain.WriteScope) error {
		var err error
		result, created, err = repo.CreateSimilar(ctx, scope.Tx(), actor, publicationID, key)
		return err
	})
	return result, created, err
}

func assertSimilarOperationAtomic(t *testing.T, ctx context.Context, owner *pgxpool.Pool, actor domain.UUID, key string, expected domain.SimilarCreation) {
	t.Helper()
	var operations, sessions, materials, tasks int
	if err := owner.QueryRow(ctx, `
		SELECT count(*), count(DISTINCT operation.session_id)
		FROM creation_publication_similar_operations operation
		WHERE operation.owner_user_id = $1 AND operation.idempotency_key = $2`, actor, key).Scan(&operations, &sessions); err != nil {
		t.Fatalf("count similar operations: %v", err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM creation_reference_materials WHERE session_id = $1`, expected.Session.ID).Scan(&materials); err != nil {
		t.Fatalf("count similar materials: %v", err)
	}
	if err := owner.QueryRow(ctx, `SELECT count(*) FROM creation_generation_tasks WHERE session_id = $1`, expected.Session.ID).Scan(&tasks); err != nil {
		t.Fatalf("count similar tasks: %v", err)
	}
	if operations != 1 || sessions != 1 || materials != len(expected.Materials) || tasks != 0 {
		t.Fatalf("partial create similar state operations=%d sessions=%d materials=%d tasks=%d", operations, sessions, materials, tasks)
	}
}

func waitForDatabaseBlock(t *testing.T, ctx context.Context, owner *pgxpool.Pool, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var blocked bool
		if err := owner.QueryRow(ctx, `SELECT cardinality(pg_blocking_pids($1)) > 0`, pid).Scan(&blocked); err != nil {
			t.Fatalf("inspect blocked publication command: %v", err)
		}
		if blocked {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("publication command never reached the held database lock")
}

func seedFinalizedUpload(t *testing.T, ctx context.Context, owner *pgxpool.Pool, fixture publicationFixture) domain.UUID {
	t.Helper()
	id := domain.NewUUID()
	if _, err := owner.Exec(ctx, `
		INSERT INTO creation_reference_material_uploads
			(id, owner_user_id, session_id, material_id, object_key, file_name, declared_kind,
			 declared_mime_type, declared_byte_size, claims_version, idempotency_key, payload_hash,
			 connection_revision, put_deadline, finalize_deadline, status, created_at, finalized_at)
		VALUES ($1, $2, $3, $4, $5, 'fixture.png', 'image', 'image/png', 1, 1, $6,
			decode(repeat('00', 32), 'hex'), 1, now() - interval '31 minutes',
			now() - interval '1 minute', 'finalized', now() - interval '91 minutes', now())`,
		id, fixture.creator, fixture.sessionID, fixture.materialID, fixture.materialBlobKey, id.String()); err != nil {
		t.Fatalf("seed finalized publication upload: %v", err)
	}
	return id
}

func assertCleanupDue(t *testing.T, ctx context.Context, owner *pgxpool.Pool, id domain.UUID, want bool) {
	t.Helper()
	var due bool
	if err := owner.QueryRow(ctx, `
		SELECT cleanup_next_attempt_at IS NOT NULL AND cleanup_confirmed_at IS NULL
		FROM creation_reference_material_uploads WHERE id = $1`, id).Scan(&due); err != nil || due != want {
		t.Fatalf("cleanup due=%v want=%v err=%v", due, want, err)
	}
}
