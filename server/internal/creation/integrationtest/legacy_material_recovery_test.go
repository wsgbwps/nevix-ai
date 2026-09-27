package integrationtest

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation"
)

func TestLegacyRemovedMaterialsRecoverOnlyWhenTheirObjectsExist(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	intent := h.imageTaskIntent(t, token, "legacy reference", 1)
	retained := h.uploadImage(t, token, intent.SessionID, "retained.png")
	unretained := h.uploadImage(t, token, intent.SessionID, "unretained.png")
	missing := h.uploadImage(t, token, intent.SessionID, "missing.png")
	mismatched := h.uploadImage(t, token, intent.SessionID, "mismatched.png")
	deletedSession := h.createSession(t, token, sessionName("legacy-deleted"))
	deletedSessionMaterial := h.uploadImage(t, token, deletedSession.ID, "deleted-session.png")
	var retainedKey, unretainedKey string
	var retainedClaims int
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT blob_key, claims_version FROM creation_reference_materials WHERE id = $1::uuid`, retained).Scan(&retainedKey, &retainedClaims); err != nil {
		t.Fatalf("read retained identity: %v", err)
	}
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT blob_key FROM creation_reference_materials WHERE id = $1::uuid`, unretained).Scan(&unretainedKey); err != nil {
		t.Fatalf("read unretained key: %v", err)
	}
	intent.Mode = "reference-image"
	intent.References = []any{
		map[string]any{"material_id": retained, "role": "reference"},
		map[string]any{"material_id": missing, "role": "reference"},
	}
	status, body := h.submitTask(t, token, "legacy-original-task", intent)
	if status != http.StatusCreated {
		t.Fatalf("admit original task: %d %s", status, body)
	}
	originalID := decodeTaskView(t, body).Task.ID
	var originalSpec string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT specification::text FROM creation_generation_tasks WHERE id = $1::uuid`, originalID).Scan(&originalSpec); err != nil {
		t.Fatalf("read original specification: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_materials SET removed_at = now() WHERE id = ANY($1::uuid[])`, []string{retained, unretained, missing, mismatched, deletedSessionMaterial}); err != nil {
		t.Fatalf("seed legacy removals: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_sessions SET deleted_at = now() WHERE id = $1::uuid`, deletedSession.ID); err != nil {
		t.Fatalf("seed deleted session: %v", err)
	}
	var mismatchedKey string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT blob_key FROM creation_reference_materials WHERE id = $1::uuid`, mismatched).Scan(&mismatchedKey); err != nil {
		t.Fatalf("read mismatched key: %v", err)
	}
	h.directStore.replaceWithGeneratedObject(mismatchedKey, 1, 0)
	// A due cleanup must wait until the legacy recovery sweep has checked it.
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_material_uploads
		SET cleanup_attempt_count = 1, cleanup_next_attempt_at = now() - interval '1 minute'
		WHERE material_id = $1::uuid`, unretained); err != nil {
		t.Fatalf("seed due legacy cleanup: %v", err)
	}
	var missingKey string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT blob_key FROM creation_reference_materials WHERE id = $1::uuid`, missing).Scan(&missingKey); err != nil {
		t.Fatalf("read missing key: %v", err)
	}
	if err := h.directStore.Delete(h.ctx, missingKey); err != nil {
		t.Fatalf("remove missing fixture object: %v", err)
	}
	missingHeads := h.directStore.headCountFor(missingKey)
	if status, body := h.doRequest(t, http.MethodDelete, "/creation/materials/"+retained, token, nil); status != http.StatusNoContent {
		t.Fatalf("old DELETE must be harmless: %d %s", status, body)
	}

	workerCtx, cancel := context.WithCancel(h.ctx)
	done := make(chan error, 1)
	go func() { done <- h.creation.RunWorkers(workerCtx) }()
	workerFinished := false
	defer func() {
		cancel()
		if !workerFinished {
			<-done
		}
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		select {
		case err := <-done:
			workerFinished = true
			t.Fatalf("creation workers stopped during recovery: %v", err)
		default:
		}
		if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_materials WHERE id = ANY($1::uuid[]) AND removed_at IS NULL`, []string{retained, unretained}) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("legacy materials with existing objects were not restored")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_materials WHERE id = $1::uuid AND removed_at IS NOT NULL`, missing) != 1 {
		t.Fatal("missing object was falsely restored")
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_task_references WHERE task_id = $1::uuid AND material_id = $2::uuid`, originalID, missing) != 1 {
		t.Fatal("missing fixture lost its live historical task relation")
	}
	status, body = h.doRequest(t, http.MethodGet, "/creation/tasks/"+originalID, token, nil)
	if status != http.StatusOK {
		t.Fatalf("read frozen task: %d %s", status, body)
	}
	var detail struct {
		ReferenceMaterials []json.RawMessage `json:"reference_materials"`
	}
	mustDecode(t, body, &detail)
	if len(detail.ReferenceMaterials) != 2 || string(detail.ReferenceMaterials[1]) != "null" {
		t.Fatalf("missing retained object looked available in task detail: %s", body)
	}
	status, body = h.doRequest(t, http.MethodGet, "/creation/sessions/"+intent.SessionID+"/tasks?limit=20", token, nil)
	if status != http.StatusOK {
		t.Fatalf("list frozen task: %d %s", status, body)
	}
	var list struct {
		Tasks []struct {
			ReferenceAvailability []bool `json:"reference_availability"`
		} `json:"tasks"`
	}
	mustDecode(t, body, &list)
	if len(list.Tasks) != 1 || len(list.Tasks[0].ReferenceAvailability) != 2 || list.Tasks[0].ReferenceAvailability[1] {
		t.Fatalf("missing retained object looked available in task list: %s", body)
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_materials WHERE id = ANY($1::uuid[]) AND removed_at IS NOT NULL`, []string{mismatched, deletedSessionMaterial}) != 2 {
		t.Fatal("unverifiable object or deleted-session material was falsely restored")
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_materials WHERE id = $1::uuid AND blob_key = $2 AND claims_version = $3`, retained, retainedKey, retainedClaims) != 1 {
		t.Fatal("recovery changed the material identity, rights claim, or object key")
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_material_uploads WHERE material_id = $1::uuid AND cleanup_attempt_count = 1`, unretained) != 1 {
		t.Fatal("cleanup claimed the object before legacy recovery")
	}
	for _, key := range h.directStore.cleanupKeys() {
		if key == unretainedKey {
			t.Fatal("claimed cleanup deleted a recovered object")
		}
	}
	status, body = h.doRequest(t, http.MethodGet, "/creation/sessions/"+intent.SessionID+"/materials?limit=20", token, nil)
	if status != http.StatusOK {
		t.Fatalf("read restored session materials: %d %s", status, body)
	}
	var listed materialList
	mustDecode(t, body, &listed)
	if len(listed.Materials) != 2 {
		t.Fatalf("restored material list: %+v", listed.Materials)
	}
	var afterSpec string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT specification::text FROM creation_generation_tasks WHERE id = $1::uuid`, originalID).Scan(&afterSpec); err != nil || afterSpec != originalSpec {
		t.Fatalf("frozen task changed: err=%v before=%s after=%s", err, originalSpec, afterSpec)
	}
	intent.References = []any{map[string]any{"material_id": unretained, "role": "reference"}}
	if status, body := h.submitTask(t, token, "legacy-reused-task", intent); status != http.StatusCreated {
		t.Fatalf("restored unretained material cannot enter new task: %d %s", status, body)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("stop first repair pass: %v", err)
	}
	workerFinished = true
	workerCtx, cancelAgain := context.WithCancel(h.ctx)
	doneAgain := make(chan error, 1)
	go func() { doneAgain <- h.creation.RunWorkers(workerCtx) }()
	defer func() { cancelAgain(); <-doneAgain }()
	deadline = time.Now().Add(15 * time.Second)
	for h.directStore.headCountFor(missingKey) < missingHeads+2 {
		if time.Now().After(deadline) {
			t.Fatal("second repair pass did not retry the still-missing object")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_materials WHERE id = ANY($1::uuid[]) AND removed_at IS NULL`, []string{retained, unretained}) != 2 ||
		countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_materials WHERE id = $1::uuid AND removed_at IS NOT NULL`, missing) != 1 {
		t.Fatal("repeated repair changed already restored or still-missing materials")
	}
}

func TestLegacyRecoveryVerifiesDeletedSessionTaskReferencesWithoutReusingThem(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	intent := h.imageTaskIntent(t, token, "archived legacy references", 1)
	available := h.uploadImage(t, token, intent.SessionID, "archived-available.png")
	missing := h.uploadImage(t, token, intent.SessionID, "archived-missing.png")
	intent.Mode = "reference-image"
	intent.References = []any{
		map[string]any{"material_id": available, "role": "reference"},
		map[string]any{"material_id": missing, "role": "reference"},
	}
	status, body := h.submitTask(t, token, "archived-legacy-task", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit archived task: %d %s", status, body)
	}
	taskID := decodeTaskView(t, body).Task.ID
	var frozen, missingKey string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT specification::text FROM creation_generation_tasks WHERE id = $1::uuid`, taskID).Scan(&frozen); err != nil {
		t.Fatal(err)
	}
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT blob_key FROM creation_reference_materials WHERE id = $1::uuid`, missing).Scan(&missingKey); err != nil {
		t.Fatal(err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_materials SET removed_at = now() WHERE id = ANY($1::uuid[])`, []string{available, missing}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_sessions SET deleted_at = now() WHERE id = $1::uuid`, intent.SessionID); err != nil {
		t.Fatal(err)
	}
	if err := h.directStore.Delete(h.ctx, missingKey); err != nil {
		t.Fatal(err)
	}

	workerCtx, cancel := context.WithCancel(h.ctx)
	done := make(chan error, 1)
	go func() { done <- h.creation.RunWorkers(workerCtx) }()
	defer func() { cancel(); <-done }()
	deadline := time.Now().Add(5 * time.Second)
	for countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_materials WHERE id = $1::uuid AND removed_at IS NOT NULL AND legacy_object_verified_at IS NOT NULL`, available) != 1 {
		if time.Now().After(deadline) {
			t.Fatal("retained archived object was not verified")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_materials WHERE id = $1::uuid AND removed_at IS NOT NULL AND legacy_object_verified_at IS NULL`, missing) != 1 {
		t.Fatal("missing archived object was falsely verified")
	}
	status, body = h.doRequest(t, http.MethodGet, "/creation/tasks/"+taskID, token, nil)
	var detail struct {
		ReferenceMaterials []json.RawMessage `json:"reference_materials"`
	}
	mustDecode(t, body, &detail)
	if status != http.StatusOK || len(detail.ReferenceMaterials) != 2 || string(detail.ReferenceMaterials[0]) == "null" || string(detail.ReferenceMaterials[1]) != "null" {
		t.Fatalf("archived historical detail: %d %s", status, body)
	}
	status, body = h.doRequest(t, http.MethodGet, "/creation/sessions/"+intent.SessionID+"/tasks?limit=20", token, nil)
	var list struct {
		Tasks []struct {
			ReferenceAvailability []bool `json:"reference_availability"`
		} `json:"tasks"`
	}
	mustDecode(t, body, &list)
	if status != http.StatusOK || len(list.Tasks) != 1 || len(list.Tasks[0].ReferenceAvailability) != 2 || !list.Tasks[0].ReferenceAvailability[0] || list.Tasks[0].ReferenceAvailability[1] {
		t.Fatalf("archived historical list: %d %s", status, body)
	}
	var after string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT specification::text FROM creation_generation_tasks WHERE id = $1::uuid`, taskID).Scan(&after); err != nil || after != frozen {
		t.Fatalf("archived frozen spec changed: %v", err)
	}
}

func TestLegacyRecoveryRetriesUnverifiableObjectWithoutClaimingCleanup(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.ensureObjectStorage(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("legacy-retry"))
	materialID := h.uploadImage(t, token, session.ID, "retry.png")
	unrelatedSession := h.createSession(t, token, sessionName("unrelated-cleanup"))
	unrelated := h.uploadImage(t, token, unrelatedSession.ID, "unrelated.png")
	var unrelatedKey string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT blob_key FROM creation_reference_materials WHERE id = $1::uuid`, unrelated).Scan(&unrelatedKey); err != nil {
		t.Fatalf("read unrelated object key: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_materials SET removed_at = now() WHERE id = $1::uuid`, unrelated); err != nil {
		t.Fatalf("mark unrelated material removed: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_sessions SET deleted_at = now() WHERE id = $1::uuid`, unrelatedSession.ID); err != nil {
		t.Fatalf("end unrelated session: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_material_uploads
		SET cleanup_attempt_count = 1, cleanup_next_attempt_at = now() - interval '1 minute'
		WHERE material_id = $1::uuid`, unrelated); err != nil {
		t.Fatalf("seed unrelated due cleanup: %v", err)
	}
	var key string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT blob_key FROM creation_reference_materials WHERE id = $1::uuid`, materialID).Scan(&key); err != nil {
		t.Fatalf("read retry object key: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_materials SET removed_at = now() WHERE id = $1::uuid`, materialID); err != nil {
		t.Fatalf("seed legacy removal: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_material_uploads
		SET cleanup_attempt_count = 1, cleanup_next_attempt_at = now() - interval '1 minute'
		WHERE material_id = $1::uuid`, materialID); err != nil {
		t.Fatalf("seed due cleanup: %v", err)
	}
	baseline := h.directStore.headCountFor(key)
	h.directStore.failHeadFor(key, errors.New("temporary storage probe failure"))
	workerCtx, cancel := context.WithCancel(h.ctx)
	done := make(chan error, 1)
	go func() { done <- h.creation.RunWorkers(workerCtx) }()
	deadline := time.Now().Add(5 * time.Second)
	for h.directStore.headCountFor(key) == baseline {
		if time.Now().After(deadline) {
			cancel()
			<-done
			t.Fatal("recovery did not probe the legacy object")
		}
		time.Sleep(20 * time.Millisecond)
	}
	for {
		_, headErr := h.directStore.Head(h.ctx, unrelatedKey)
		if errors.Is(headErr, creation.ErrBlobNotFound) {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			<-done
			t.Fatal("uncertain legacy key blocked unrelated cleanup")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("stop failed probe pass: %v", err)
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_materials WHERE id = $1::uuid AND removed_at IS NOT NULL`, materialID) != 1 ||
		countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_material_uploads WHERE material_id = $1::uuid AND cleanup_attempt_count = 1`, materialID) != 1 {
		t.Fatal("uncertain storage probe restored material or claimed its cleanup")
	}
	if _, err := h.directStore.Head(h.ctx, unrelatedKey); !errors.Is(err, creation.ErrBlobNotFound) {
		t.Fatalf("unrelated due object was not cleaned: %v", err)
	}
	workerCtx, cancel = context.WithCancel(h.ctx)
	done = make(chan error, 1)
	go func() { done <- h.creation.RunWorkers(workerCtx) }()
	defer func() { cancel(); <-done }()
	deadline = time.Now().Add(5 * time.Second)
	for countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_materials WHERE id = $1::uuid AND removed_at IS NULL`, materialID) != 1 {
		if time.Now().After(deadline) {
			t.Fatal("retry did not restore available legacy object")
		}
		time.Sleep(20 * time.Millisecond)
	}
	for _, deleted := range h.directStore.cleanupKeys() {
		if deleted == key {
			t.Fatal("retry deleted the restored object")
		}
	}
}

func TestLegacyRecoveryFinishesAllPagesBeforeCleanup(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.ensureObjectStorage(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("legacy-pages"))
	materialID := h.uploadImage(t, token, session.ID, "last-page.png")
	var key string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT blob_key FROM creation_reference_materials WHERE id = $1::uuid`, materialID).Scan(&key); err != nil {
		t.Fatalf("read last-page key: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `
		INSERT INTO creation_reference_materials
		  (id, session_id, kind, file_name, mime_type, byte_size, checksum_sha256,
		   blob_key, width_px, height_px, pixel_count, removed_at)
		SELECT ('00000000-0000-0000-0000-' || lpad(to_hex(i), 12, '0'))::uuid,
		       $1::uuid, 'image', 'lost.png', 'image/png', 1, decode(repeat('00', 32), 'hex'),
		       'legacy-missing/' || i, 1, 1, 1, now()
		FROM generate_series(1, 100) AS i
		ON CONFLICT DO NOTHING`, session.ID); err != nil {
		t.Fatalf("seed first recovery page: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_materials SET removed_at = now() WHERE id = $1::uuid`, materialID); err != nil {
		t.Fatalf("seed last-page material: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_material_uploads
		SET cleanup_attempt_count = 1, cleanup_next_attempt_at = now() - interval '1 minute'
		WHERE material_id = $1::uuid`, materialID); err != nil {
		t.Fatalf("seed due last-page cleanup: %v", err)
	}
	workerCtx, cancel := context.WithCancel(h.ctx)
	done := make(chan error, 1)
	go func() { done <- h.creation.RunWorkers(workerCtx) }()
	defer func() { cancel(); <-done }()
	deadline := time.Now().Add(10 * time.Second)
	for countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_materials WHERE id = $1::uuid AND removed_at IS NULL`, materialID) != 1 {
		select {
		case err := <-done:
			t.Fatalf("recovery stopped before last page: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("last-page material was not restored before cleanup")
		}
		time.Sleep(20 * time.Millisecond)
	}
	for _, deleted := range h.directStore.cleanupKeys() {
		if deleted == key {
			t.Fatal("cleanup deleted a recoverable object beyond the first page")
		}
	}
}

func TestLegacyCleanupHoldsObjectLockThroughObjectDeletion(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.ensureObjectStorage(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("legacy-delete-race"))
	materialID := h.uploadImage(t, token, session.ID, "cleanup.png")
	var key string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT blob_key FROM creation_reference_materials WHERE id = $1::uuid`, materialID).Scan(&key); err != nil {
		t.Fatalf("read cleanup object key: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_materials SET removed_at = now() WHERE id = $1::uuid`, materialID); err != nil {
		t.Fatalf("seed old removal: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_sessions SET deleted_at = now() WHERE id = $1::uuid`, session.ID); err != nil {
		t.Fatalf("end source session: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_material_uploads
		SET cleanup_attempt_count = 1, cleanup_next_attempt_at = now() - interval '1 minute'
		WHERE material_id = $1::uuid`, materialID); err != nil {
		t.Fatalf("seed due cleanup: %v", err)
	}
	started, release := h.directStore.waitOnNextDelete(key)
	workerCtx, cancel := context.WithCancel(h.ctx)
	done := make(chan error, 1)
	go func() { done <- h.creation.RunWorkers(workerCtx) }()
	released := false
	defer func() {
		if !released {
			close(release)
		}
		cancel()
		<-done
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("cleanup never reached exact object deletion")
	}
	connection, err := h.ownerPool.Acquire(h.ctx)
	if err != nil {
		t.Fatalf("acquire competing recovery connection: %v", err)
	}
	defer connection.Release()
	var acquired bool
	if err := connection.QueryRow(h.ctx, `SELECT pg_try_advisory_lock(hashtextextended($1, 320))`, key).Scan(&acquired); err != nil {
		t.Fatalf("inspect recovery lock: %v", err)
	}
	if acquired {
		_, _ = connection.Exec(h.ctx, `SELECT pg_advisory_unlock(hashtextextended($1, 320))`, key)
		t.Fatal("recovery object lock was free during object Delete")
	}
	close(release)
	released = true
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := h.directStore.Head(h.ctx, key); errors.Is(err, creation.ErrBlobNotFound) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("unretained object did not finish exact-key cleanup")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestLegacyRecoveryReleasesDismissedTaskRelations(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	intent := h.imageTaskIntent(t, token, "dismissed legacy", 1)
	materialID := h.uploadImage(t, token, intent.SessionID, "dismissed.png")
	intent.Mode = "reference-image"
	intent.References = []any{map[string]any{"material_id": materialID, "role": "reference"}}
	status, body := h.submitTask(t, token, "dismissed-legacy-task", intent)
	if status != http.StatusCreated {
		t.Fatalf("admit historical task: %d %s", status, body)
	}
	taskID := decodeTaskView(t, body).Task.ID
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_generation_tasks SET dismissed_at = now() WHERE id = $1::uuid`, taskID); err != nil {
		t.Fatalf("seed dismissed task: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_materials SET removed_at = now() WHERE id = $1::uuid`, materialID); err != nil {
		t.Fatalf("seed legacy removed material: %v", err)
	}
	workerCtx, cancel := context.WithCancel(h.ctx)
	done := make(chan error, 1)
	go func() { done <- h.creation.RunWorkers(workerCtx) }()
	workerFinished := false
	defer func() {
		cancel()
		if !workerFinished {
			<-done
		}
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		select {
		case err := <-done:
			workerFinished = true
			t.Fatalf("creation workers stopped during recovery: %v", err)
		default:
		}
		if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_materials WHERE id = $1::uuid AND removed_at IS NULL`, materialID) == 1 &&
			countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_task_references WHERE task_id = $1::uuid`, taskID) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("legacy recovery did not release dismissed task's stale relation")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status, body := h.doRequest(t, http.MethodGet, "/creation/tasks/"+taskID, token, nil); status != http.StatusOK {
		t.Fatalf("dismissed task lost historical detail: %d %s", status, body)
	} else if view := decodeTaskView(t, body); view.Specification == nil || len(view.Specification.References) != 1 || view.Specification.References[0].MaterialID != materialID {
		t.Fatalf("dismissed task lost frozen reference: %s", body)
	}
}

func TestLegacyDismissedLastHolderArmsExactKeyCleanup(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	intent := h.imageTaskIntent(t, token, "dismissed last holder", 1)
	materialID := h.uploadImage(t, token, intent.SessionID, "last-holder.png")
	intent.Mode = "reference-image"
	intent.References = []any{map[string]any{"material_id": materialID, "role": "reference"}}
	status, body := h.submitTask(t, token, "dismissed-last-holder", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	taskID := decodeTaskView(t, body).Task.ID
	var key string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT blob_key FROM creation_reference_materials WHERE id = $1::uuid`, materialID).Scan(&key); err != nil {
		t.Fatal(err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_generation_tasks SET dismissed_at = now() WHERE id = $1::uuid`, taskID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_materials SET removed_at = now() WHERE id = $1::uuid`, materialID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_sessions SET deleted_at = now() WHERE id = $1::uuid`, intent.SessionID); err != nil {
		t.Fatal(err)
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_material_uploads WHERE material_id = $1::uuid AND cleanup_next_attempt_at IS NULL`, materialID) != 1 {
		t.Fatal("fixture cleanup was already due")
	}
	workerCtx, cancel := context.WithCancel(h.ctx)
	done := make(chan error, 1)
	go func() { done <- h.creation.RunWorkers(workerCtx) }()
	defer func() { cancel(); <-done }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, headErr := h.directStore.Head(h.ctx, key)
		if errors.Is(headErr, creation.ErrBlobNotFound) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("last dismissed holder's object was not cleaned")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_task_references WHERE task_id = $1::uuid`, taskID) != 0 ||
		countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_material_uploads WHERE material_id = $1::uuid AND cleanup_attempt_count > 0`, materialID) != 1 {
		t.Fatal("stale relation release did not arm exact-key cleanup")
	}
}
