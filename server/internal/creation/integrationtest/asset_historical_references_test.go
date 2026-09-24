package integrationtest

import (
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestAssetDetailsKeepConfirmedHistoricalReferences(t *testing.T) {
	h, adminToken, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creatorToken := h.loginToken(t, creatorEmailAddress, harnessPassword)
	otherToken := h.loginToken(t, otherCreatorEmail, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})
	createdSince := url.QueryEscape(time.Now().UTC().Format(time.RFC3339Nano))
	intent := h.imageTaskIntent(t, creatorToken, "Frozen historical references", 1)
	available := h.uploadImage(t, creatorToken, intent.SessionID, "available.png")
	missingRow := h.uploadImage(t, creatorToken, intent.SessionID, "missing-row.png")
	missingRetention := h.uploadImage(t, creatorToken, intent.SessionID, "missing-retention.png")
	intent.Mode = "reference-image"
	intent.References = []any{
		map[string]any{"material_id": available, "role": "reference"},
		map[string]any{"material_id": missingRow, "role": "reference"},
		map[string]any{"material_id": missingRetention, "role": "reference"},
		map[string]any{"material_id": available, "role": "reference"},
	}
	status, body := h.submitTask(t, creatorToken, "asset-historical-references", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit: status=%d body=%s", status, body)
	}
	taskID := decodeTaskView(t, body).Task.ID
	if view := h.awaitTaskTerminal(t, creatorToken, taskID); view.Task.Status != "succeeded" {
		t.Fatalf("task status=%s", view.Task.Status)
	}
	page := readAssetPage(t, h, creatorToken, "/creation/assets?created_since="+createdSince)
	if len(page.Assets) != 1 {
		t.Fatalf("formed Assets=%+v", page.Assets)
	}
	assetID := page.Assets[0].ID

	for name, request := range map[string]struct{ path, token string }{
		"creator": {"/creation/assets/" + assetID, creatorToken},
		"admin":   {"/creation/inspiration/assets/" + assetID, adminToken},
	} {
		status, payload := h.doRequest(t, http.MethodGet, request.path, request.token, nil)
		if status != http.StatusOK {
			t.Fatalf("healthy %s detail status=%d body=%s", name, status, payload)
		}
	}

	if _, err := h.ownerPool.Exec(h.ctx, `DELETE FROM creation_generation_task_references WHERE task_id = $1::uuid AND material_id IN ($2::uuid, $3::uuid)`, taskID, missingRow, missingRetention); err != nil {
		t.Fatalf("remove historical retention: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `DELETE FROM creation_reference_materials WHERE id = $1::uuid`, missingRow); err != nil {
		t.Fatalf("remove historical material row: %v", err)
	}

	for name, request := range map[string]struct{ path, token string }{
		"creator": {"/creation/assets/" + assetID, creatorToken},
		"admin":   {"/creation/inspiration/assets/" + assetID, adminToken},
	} {
		status, payload := h.doRequest(t, http.MethodGet, request.path, request.token, nil)
		if status != http.StatusOK {
			t.Fatalf("partial %s detail status=%d body=%s", name, status, payload)
		}
		var detail struct {
			Asset struct {
				ID string `json:"id"`
			} `json:"asset"`
			Specification struct {
				Prompt     string `json:"prompt"`
				References []struct {
					MaterialID string `json:"material_id"`
				} `json:"references"`
			} `json:"specification"`
			References []struct {
				ID       string `json:"id"`
				FileName string `json:"file_name"`
			} `json:"references"`
			PrivateOrigin *struct {
				Specification struct {
					Prompt     string `json:"prompt"`
					References []struct {
						MaterialID string `json:"material_id"`
					} `json:"references"`
				} `json:"specification"`
				References []struct {
					ID       string `json:"id"`
					FileName string `json:"file_name"`
				} `json:"references"`
			} `json:"private_origin"`
		}
		mustDecode(t, payload, &detail)
		spec, refs := detail.Specification, detail.References
		if name == "creator" {
			if detail.PrivateOrigin == nil {
				t.Fatalf("creator origin missing: %s", payload)
			}
			spec, refs = detail.PrivateOrigin.Specification, detail.PrivateOrigin.References
		}
		if detail.Asset.ID != assetID || spec.Prompt != intent.Prompt || len(spec.References) != 4 ||
			spec.References[0].MaterialID != available || spec.References[1].MaterialID != missingRow ||
			spec.References[2].MaterialID != missingRetention || spec.References[3].MaterialID != available ||
			len(refs) != 2 || refs[0].ID != available || refs[1].ID != available ||
			refs[0].FileName != "available.png" || refs[1].FileName != "available.png" {
			t.Fatalf("%s lost frozen positions or confirmed subsequence: %s", name, payload)
		}
	}

	adminReferencePath := "/creation/inspiration/assets/" + assetID + "/references/"
	if status, payload := h.doRequest(t, http.MethodGet, adminReferencePath+available+"/preview-url", adminToken, nil); status != http.StatusOK {
		t.Fatalf("confirmed companion preview status=%d body=%s", status, payload)
	}
	for _, id := range []string{missingRow, missingRetention} {
		if status, payload := h.doRequest(t, http.MethodGet, adminReferencePath+id+"/preview-url", adminToken, nil); status != http.StatusNotFound {
			t.Fatalf("missing reference %s preview status=%d body=%s", id, status, payload)
		}
	}
	if status, payload := h.doRequest(t, http.MethodGet, "/creation/materials/"+missingRetention+"/preview-url", creatorToken, nil); status != http.StatusOK {
		t.Fatalf("independent creator material preview status=%d body=%s", status, payload)
	}
	if status, payload := h.doRequest(t, http.MethodGet, "/creation/inspiration/assets/"+assetID+"/preview-url", adminToken, nil); status != http.StatusOK {
		t.Fatalf("asset media preview status=%d body=%s", status, payload)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/assets/"+assetID, otherToken, nil); status != http.StatusNotFound {
		t.Fatalf("foreign creator detail status=%d", status)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/inspiration/assets/"+assetID, otherToken, nil); status != http.StatusForbidden {
		t.Fatalf("non-admin inspiration detail status=%d", status)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/inspiration/assets/00000000-0000-0000-0000-000000000001", adminToken, nil); status != http.StatusNotFound {
		t.Fatalf("unknown inspiration asset status=%d", status)
	}
	mutateRestriction(t, h, http.MethodPut, "/creation/inspiration/assets/"+assetID+"/restriction", adminToken, "asset")
	if status, payload := h.doRequest(t, http.MethodGet, "/creation/inspiration/assets/"+assetID, adminToken, nil); status != http.StatusOK {
		t.Fatalf("restricted governance detail status=%d body=%s", status, payload)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/assets/"+assetID, creatorToken, nil); status != http.StatusNotFound {
		t.Fatalf("restricted creator detail status=%d", status)
	}
	if status, payload := h.doRequest(t, http.MethodDelete, "/creation/assets/"+assetID, adminToken, nil); status != http.StatusNoContent {
		t.Fatalf("admin delete status=%d body=%s", status, payload)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/inspiration/assets/"+assetID, adminToken, nil); status != http.StatusNotFound {
		t.Fatalf("deleted inspiration asset status=%d", status)
	}
}
