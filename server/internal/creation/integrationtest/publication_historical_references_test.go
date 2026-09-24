package integrationtest

import (
	"net/http"
	"testing"
)

func TestPublicationRejectsUnavailableHistoricalReferences(t *testing.T) {
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creator := h.loginToken(t, creatorEmailAddress, harnessPassword)
	other := h.loginToken(t, otherCreatorEmail, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})

	formAsset := func(name string) (assetID, taskID, missing string) {
		t.Helper()
		intent := h.imageTaskIntent(t, creator, name, 1)
		available := h.uploadImage(t, creator, intent.SessionID, name+"-available.png")
		missing = h.uploadImage(t, creator, intent.SessionID, name+"-missing.png")
		intent.Mode = "reference-image"
		intent.References = []any{
			map[string]any{"material_id": available, "role": "reference"},
			map[string]any{"material_id": missing, "role": "reference"},
		}
		status, body := h.submitTask(t, creator, name, intent)
		if status != http.StatusCreated {
			t.Fatalf("submit %s: status=%d body=%s", name, status, body)
		}
		taskID = decodeTaskView(t, body).Task.ID
		if view := h.awaitTaskTerminal(t, creator, taskID); view.Task.Status != "succeeded" {
			t.Fatalf("task %s status=%s", name, view.Task.Status)
		}
		return newestAssetID(t, h, creator), taskID, missing
	}

	healthyAsset, _, _ := formAsset("publication-complete-history")
	healthyPath := "/creation/assets/" + healthyAsset + "/publication"
	status, body := h.doRequest(t, http.MethodPost, healthyPath, creator, map[string]any{"idempotency_key": "publication-complete-history"})
	if status != http.StatusCreated {
		t.Fatalf("healthy publish status=%d body=%s", status, body)
	}
	publicationID := extractNestedField(t, body, "publication", "id")
	status, body = h.doRequest(t, http.MethodGet, "/creation/publications/"+publicationID, other, nil)
	var healthy publicationDetailView
	mustDecode(t, body, &healthy)
	if status != http.StatusOK || len(healthy.Specification.References) != 2 || len(healthy.References) != 2 {
		t.Fatalf("healthy publication snapshot status=%d body=%s", status, body)
	}

	for _, scenario := range []struct {
		name              string
		deleteMaterialRow bool
	}{
		{"missing-material-row", true},
		{"missing-task-retention", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			assetID, taskID, missing := formAsset("publication-" + scenario.name)
			path := "/creation/assets/" + assetID + "/publication"
			page := readAssetPage(t, h, creator, "/creation/assets?search="+assetID)
			if len(page.Assets) != 1 || !page.Assets[0].Capabilities.CanPublish {
				t.Fatalf("list publication capability for %s = %+v", scenario.name, page.Assets)
			}
			if status, body := h.doRequest(t, http.MethodGet, "/creation/assets/"+assetID, creator, nil); status != http.StatusOK {
				t.Fatalf("pre-change detail status=%d body=%s", status, body)
			}
			if status, body := h.doRequest(t, http.MethodPost, path, other, map[string]any{"idempotency_key": "foreign-" + scenario.name}); status != http.StatusNotFound {
				t.Fatalf("foreign publish status=%d body=%s", status, body)
			}
			if _, err := h.ownerPool.Exec(h.ctx, `DELETE FROM creation_generation_task_references WHERE task_id = $1::uuid AND material_id = $2::uuid`, taskID, missing); err != nil {
				t.Fatalf("remove task retention: %v", err)
			}
			if scenario.deleteMaterialRow {
				if _, err := h.ownerPool.Exec(h.ctx, `DELETE FROM creation_reference_materials WHERE id = $1::uuid`, missing); err != nil {
					t.Fatalf("remove material row: %v", err)
				}
			}
			status, body := h.doRequest(t, http.MethodPost, path, creator, map[string]any{"idempotency_key": "publication-" + scenario.name})
			if status != http.StatusConflict || extractField(t, body, "error") != "asset_reference_unavailable" {
				t.Fatalf("incomplete publish status=%d body=%s", status, body)
			}
			assertContractResponse(t, http.MethodPost, path, status, body)
			status, body = h.doRequest(t, http.MethodGet, "/creation/assets/"+assetID, creator, nil)
			var afterConflict adminPublicationStateView
			mustDecode(t, body, &afterConflict)
			if status != http.StatusOK || afterConflict.Asset.Publication != nil {
				t.Fatalf("publication formed after conflict status=%d body=%s", status, body)
			}
			if scenario.deleteMaterialRow {
				if status, body := h.doRequest(t, http.MethodDelete, "/creation/assets/"+assetID, creator, nil); status != http.StatusNoContent {
					t.Fatalf("delete asset status=%d body=%s", status, body)
				}
				if status, body := h.doRequest(t, http.MethodPost, path, creator, map[string]any{"idempotency_key": "publication-deleted-history"}); status != http.StatusNotFound {
					t.Fatalf("deleted asset publish status=%d body=%s", status, body)
				}
			}
		})
	}

	if status, body := h.doRequest(t, http.MethodPost, "/creation/assets/00000000-0000-0000-0000-000000000001/publication", creator, map[string]any{"idempotency_key": "publication-unknown-history"}); status != http.StatusNotFound {
		t.Fatalf("unknown asset publish status=%d body=%s", status, body)
	}
}
