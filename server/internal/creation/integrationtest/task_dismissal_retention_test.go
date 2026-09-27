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

func materialObjectKey(t *testing.T, h *harness, materialID string) string {
	t.Helper()
	var key string
	if err := h.ownerPool.QueryRow(h.ctx,
		`SELECT blob_key FROM creation_reference_materials WHERE id = $1::uuid`, materialID).Scan(&key); err != nil {
		t.Fatalf("read material object key: %v", err)
	}
	return key
}

func awaitMaterialCleanup(t *testing.T, h *harness, materialID, key string) {
	t.Helper()
	// The harness worker polls cleanup once a minute; start a fresh pass after
	// the final holder disappears instead of waiting for its next tick.
	workerCtx, cancel := context.WithCancel(h.ctx)
	done := make(chan error, 1)
	go func() { done <- h.creation.RunWorkers(workerCtx) }()
	defer func() { cancel(); <-done }()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_, err := h.directStore.Head(h.ctx, key)
		if errors.Is(err, creation.ErrBlobNotFound) && countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_material_uploads
			WHERE material_id = $1::uuid AND cleanup_attempt_count > 0`, materialID) == 1 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("last holder did not cause exact-key cleanup for material %s", materialID)
}

func TestDismissingSharedReferenceReleasesOnlyItsTaskAndCleansTheLastHolder(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	foreign := h.loginToken(t, otherCreatorEmail, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})
	intent := h.imageTaskIntent(t, token, "shared reference retention", 1)
	materialID := h.uploadImage(t, token, intent.SessionID, "shared.png")
	key := materialObjectKey(t, h, materialID)
	intent.Mode = "reference-image"
	intent.References = []any{map[string]any{"material_id": materialID, "role": "reference"}}
	admit := func(idempotencyKey string) string {
		t.Helper()
		status, body := h.submitTask(t, token, idempotencyKey, intent)
		if status != http.StatusCreated {
			t.Fatalf("admit %s: status=%d body=%s", idempotencyKey, status, body)
		}
		taskID := decodeTaskView(t, body).Task.ID
		if task := h.awaitTaskTerminal(t, token, taskID); task.Task.Status != "succeeded" {
			t.Fatalf("task %s ended %s", taskID, task.Task.Status)
		}
		return taskID
	}
	a, b := admit("shared-reference-a"), admit("shared-reference-b")
	var resultKey string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT result_blob_key FROM creation_generation_slots
		WHERE task_id = $1::uuid AND slot_index = 0`, b).Scan(&resultKey); err != nil {
		t.Fatalf("read B result key: %v", err)
	}
	if resultKey == key {
		t.Fatal("generated result unexpectedly shares the reference key")
	}
	if status, _ := h.dismissTask(t, foreign, a); status != http.StatusNotFound {
		t.Fatalf("foreign dismissal status=%d", status)
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_task_references
		WHERE task_id IN ($1::uuid, $2::uuid) AND material_id = $3::uuid`, a, b, materialID) != 2 {
		t.Fatal("foreign dismissal released a task reference")
	}
	if status, body := h.dismissTask(t, token, a); status != http.StatusOK {
		t.Fatalf("dismiss A: status=%d body=%s", status, body)
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_task_references
		WHERE task_id = $1::uuid`, a) != 0 ||
		countRows(t, h.ownerPool, `SELECT count(*) FROM creation_generation_task_references
		WHERE task_id = $1::uuid AND material_id = $2::uuid`, b, materialID) != 1 {
		t.Fatal("A dismissal did not release precisely A's relation")
	}
	status, body, dismissed := h.getTask(t, token, a)
	if status != http.StatusOK || dismissed.Specification == nil || dismissed.Specification.Prompt != intent.Prompt ||
		len(dismissed.Specification.References) != 1 || dismissed.Specification.References[0].MaterialID != materialID {
		t.Fatalf("A lost its frozen text: status=%d body=%s", status, body)
	}
	var aDetail struct {
		ReferenceMaterials []json.RawMessage `json:"reference_materials"`
	}
	mustDecode(t, body, &aDetail)
	if len(aDetail.ReferenceMaterials) != 1 || string(aDetail.ReferenceMaterials[0]) != "null" {
		t.Fatalf("dismissed A still projected task media: %s", body)
	}
	status, body, remaining := h.getTask(t, token, b)
	if status != http.StatusOK || remaining.Specification == nil || remaining.Specification.Prompt != intent.Prompt ||
		len(remaining.Specification.References) != 1 || remaining.Specification.References[0].MaterialID != materialID {
		t.Fatalf("B lost its frozen reference: status=%d body=%s", status, body)
	}
	var bDetail struct {
		ReferenceMaterials []struct {
			ID string `json:"id"`
		} `json:"reference_materials"`
	}
	mustDecode(t, body, &bDetail)
	if len(bDetail.ReferenceMaterials) != 1 || bDetail.ReferenceMaterials[0].ID != materialID {
		t.Fatalf("B lost current reference projection: %s", body)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/materials/"+materialID+"/thumbnail-url", token, nil); status != http.StatusOK {
		t.Fatalf("B thumbnail status=%d", status)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/materials/"+materialID+"/preview-url", token, nil); status != http.StatusOK {
		t.Fatalf("B preview status=%d", status)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/materials/"+materialID+"/thumbnail-url", foreign, nil); status != http.StatusNotFound {
		t.Fatalf("foreign thumbnail status=%d", status)
	}
	if status, body := h.doRequest(t, http.MethodDelete, "/creation/sessions/"+intent.SessionID, token, nil); status != http.StatusNoContent {
		t.Fatalf("delete source session: status=%d body=%s", status, body)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/materials/"+materialID+"/thumbnail-url", token, nil); status != http.StatusOK {
		t.Fatalf("B retention did not survive session deletion: status=%d", status)
	}
	if _, err := h.directStore.Head(h.ctx, key); err != nil {
		t.Fatalf("shared reference deleted while B retained it: %v", err)
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_material_uploads
		WHERE material_id = $1::uuid AND cleanup_next_attempt_at IS NOT NULL`, materialID) != 0 {
		t.Fatal("cleanup armed while B retained the material")
	}
	if status, body := h.dismissTask(t, token, b); status != http.StatusOK {
		t.Fatalf("dismiss B: status=%d body=%s", status, body)
	}
	awaitMaterialCleanup(t, h, materialID, key)
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/materials/"+materialID+"/thumbnail-url", token, nil); status != http.StatusNotFound {
		t.Fatalf("released material still authorized: status=%d", status)
	}
	if _, err := h.directStore.Head(h.ctx, resultKey); err != nil {
		t.Fatalf("reference cleanup deleted B's generated result: %v", err)
	}
	for _, deleted := range h.directStore.cleanupKeys() {
		if deleted == resultKey {
			t.Fatal("reference cleanup attempted to delete B's result key")
		}
	}
}

func TestPublicationKeepsSharedReferenceAfterTaskAndSessionDeletion(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	member := h.loginToken(t, otherCreatorEmail, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})
	intent := h.imageTaskIntent(t, token, "publication holds reference", 1)
	materialID := h.uploadImage(t, token, intent.SessionID, "published.png")
	key := materialObjectKey(t, h, materialID)
	intent.Mode = "reference-image"
	intent.References = []any{map[string]any{"material_id": materialID, "role": "reference"}}
	status, body := h.submitTask(t, token, "publication-reference-holder", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit source task: status=%d body=%s", status, body)
	}
	taskID := decodeTaskView(t, body).Task.ID
	if task := h.awaitTaskTerminal(t, token, taskID); task.Task.Status != "succeeded" {
		t.Fatalf("source task status=%s", task.Task.Status)
	}
	assets := assetIDsOfTask(t, h, taskID)
	if len(assets) != 1 {
		t.Fatalf("source assets=%v", assets)
	}
	status, body = h.doRequest(t, http.MethodPost, "/creation/assets/"+assets[0]+"/publication", token,
		map[string]any{"idempotency_key": "publication-reference-holder"})
	if status != http.StatusCreated {
		t.Fatalf("publish: status=%d body=%s", status, body)
	}
	publicationID := extractNestedField(t, body, "publication", "id")
	if status, body := h.dismissTask(t, token, taskID); status != http.StatusOK {
		t.Fatalf("dismiss source task: status=%d body=%s", status, body)
	}
	if status, body := h.doRequest(t, http.MethodDelete, "/creation/sessions/"+intent.SessionID, token, nil); status != http.StatusNoContent {
		t.Fatalf("delete source session: status=%d body=%s", status, body)
	}
	status, body = h.doRequest(t, http.MethodGet, "/creation/publications/"+publicationID, member, nil)
	var publication publicationDetailView
	mustDecode(t, body, &publication)
	if status != http.StatusOK || len(publication.References) != 1 {
		t.Fatalf("publication lost reference after source deletion: status=%d body=%s", status, body)
	}
	if status, body := h.doRequest(t, http.MethodGet, "/creation/publications/"+publicationID+
		"/references/"+publication.References[0].ID+"/preview-url", member, nil); status != http.StatusOK {
		t.Fatalf("publication reference preview: status=%d body=%s", status, body)
	}
	if _, err := h.directStore.Head(h.ctx, key); err != nil {
		t.Fatalf("publication's reference object disappeared: %v", err)
	}
	if status, body := h.doRequest(t, http.MethodDelete, "/creation/publications/"+publicationID, token, nil); status != http.StatusNoContent {
		t.Fatalf("withdraw publication: status=%d body=%s", status, body)
	}
	awaitMaterialCleanup(t, h, materialID, key)
}

func TestResultDerivedMaterialHasDurableCleanupFactWithoutDeletingGenerationResult(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})
	intent := h.imageTaskIntent(t, token, "result-derived reference", 1)
	status, body := h.submitTask(t, token, "result-derived-source", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit source task: status=%d body=%s", status, body)
	}
	taskID := decodeTaskView(t, body).Task.ID
	if task := h.awaitTaskTerminal(t, token, taskID); task.Task.Status != "succeeded" {
		t.Fatalf("source task status=%s", task.Task.Status)
	}
	status, body = h.doRequest(t, http.MethodPost, "/creation/sessions/"+intent.SessionID+"/materials/from-result", token,
		map[string]any{"task_id": taskID, "slot_index": 0, "file_name": "from-result.png"})
	if status != http.StatusCreated {
		t.Fatalf("convert result: status=%d body=%s", status, body)
	}
	materialID := extractField(t, body, "id")
	key := materialObjectKey(t, h, materialID)
	var resultKey string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT result_blob_key FROM creation_generation_slots
		WHERE task_id = $1::uuid AND slot_index = 0`, taskID).Scan(&resultKey); err != nil {
		t.Fatalf("read result key: %v", err)
	}
	if key == resultKey {
		t.Fatal("result conversion did not create an independent reference object")
	}
	if countRows(t, h.ownerPool, `SELECT count(*) FROM creation_reference_material_uploads
		WHERE material_id = $1::uuid AND object_key = $2 AND status = 'finalized'`, materialID, key) != 1 {
		t.Fatal("result-derived material lacks a durable exact-key cleanup fact")
	}
	if status, body := h.doRequest(t, http.MethodDelete, "/creation/sessions/"+intent.SessionID, token, nil); status != http.StatusNoContent {
		t.Fatalf("delete result-derived material session: status=%d body=%s", status, body)
	}
	awaitMaterialCleanup(t, h, materialID, key)
	if status, body := h.doRequest(t, http.MethodGet, "/creation/tasks/"+taskID+"/slots/0/result", token, nil); status != http.StatusOK || len(body) == 0 {
		t.Fatalf("source result lost after material release: status=%d body=%s", status, body)
	}
	if _, err := h.directStore.Head(h.ctx, resultKey); err != nil {
		t.Fatalf("material cleanup deleted generation result: %v", err)
	}
	for _, deleted := range h.directStore.cleanupKeys() {
		if deleted == resultKey {
			t.Fatal("cleanup attempted to delete the generated result key")
		}
	}
}
