package integrationtest

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
)

func TestTaskListProjectsHistoricalReferenceAvailabilityByFrozenPosition(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	foreign := h.loginToken(t, otherCreatorEmail, harnessPassword)
	intent := h.imageTaskIntent(t, token, "Historical reference projection", 1)
	available := h.uploadImage(t, token, intent.SessionID, "available.png")
	missingRow := h.uploadImage(t, token, intent.SessionID, "missing-row.png")
	missingRetention := h.uploadImage(t, token, intent.SessionID, "missing-retention.png")
	intent.Mode = "reference-image"
	intent.References = []any{
		map[string]any{"material_id": available, "role": "reference"},
		map[string]any{"material_id": missingRow, "role": "reference"},
		map[string]any{"material_id": missingRetention, "role": "reference"},
		map[string]any{"material_id": available, "role": "reference"},
	}
	status, body := h.submitTask(t, token, "availability-with-references", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit referenced task: status=%d body=%s", status, body)
	}
	taskID := decodeTaskView(t, body).Task.ID
	plain := h.buildTaskIntent(t, token, intent.SessionID, taskIntent{
		MediaType: "image", Model: intent.Model, Mode: "text-to-image", Ratio: intent.Ratio,
		Resolution: intent.Resolution, Quantity: 1, Prompt: "No frozen references",
	})
	if status, body := h.submitTask(t, token, "availability-without-references", plain); status != http.StatusCreated {
		t.Fatalf("submit plain task: status=%d body=%s", status, body)
	}
	// A development-era removed row remains unavailable even if the task retains it.
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_materials SET removed_at = now() WHERE id = $1::uuid`, available); err != nil {
		t.Fatalf("hide historically retained material: %v", err)
	}
	path := "/creation/sessions/" + intent.SessionID + "/tasks?limit=20"
	read := func() (string, []bool) {
		t.Helper()
		status, body := h.doRequest(t, http.MethodGet, path, token, nil)
		if status != http.StatusOK {
			t.Fatalf("list status=%d body=%s", status, body)
		}
		assertContractResponse(t, http.MethodGet, "/creation/sessions/"+intent.SessionID+"/tasks", status, body)
		var page struct {
			Tasks []struct {
				ID                    string `json:"id"`
				UpdatedAt             string `json:"updated_at"`
				ReferenceAvailability []bool `json:"reference_availability"`
				Snapshot              struct {
					References []struct {
						MaterialID string `json:"material_id"`
					} `json:"references"`
				} `json:"snapshot"`
			} `json:"tasks"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			t.Fatalf("decode list: %v", err)
		}
		if len(page.Tasks) != 2 || page.Tasks[0].ReferenceAvailability == nil || len(page.Tasks[0].Snapshot.References) != 0 {
			t.Fatalf("plain task availability or snapshot: %s", body)
		}
		for _, item := range page.Tasks {
			if item.ID != taskID {
				continue
			}
			if len(item.Snapshot.References) != 4 || item.Snapshot.References[0].MaterialID != available ||
				item.Snapshot.References[1].MaterialID != missingRow ||
				item.Snapshot.References[2].MaterialID != missingRetention ||
				item.Snapshot.References[3].MaterialID != available {
				t.Fatalf("frozen reference positions changed: %s", body)
			}
			return item.UpdatedAt, item.ReferenceAvailability
		}
		t.Fatalf("referenced task missing from list: %s", body)
		return "", nil
	}
	updatedAt, availability := read()
	if !reflect.DeepEqual(availability, []bool{false, true, true, false}) {
		t.Fatalf("removed reference availability=%v", availability)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `DELETE FROM creation_generation_task_references WHERE task_id = $1::uuid AND material_id IN ($2::uuid, $3::uuid)`, taskID, missingRow, missingRetention); err != nil {
		t.Fatalf("remove retention: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `DELETE FROM creation_reference_materials WHERE id = $1::uuid`, missingRow); err != nil {
		t.Fatalf("remove material row: %v", err)
	}
	if after, got := read(); after != updatedAt || !reflect.DeepEqual(got, []bool{false, false, false, false}) {
		t.Fatalf("same updated_at must permit changed availability: before=%q after=%q availability=%v", updatedAt, after, got)
	}
	status, body = h.doRequest(t, http.MethodGet, "/creation/tasks/"+taskID, token, nil)
	if status != http.StatusOK {
		t.Fatalf("task detail status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodGet, "/creation/tasks/"+taskID, status, body)
	var detail map[string]json.RawMessage
	if err := json.Unmarshal(body, &detail); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	var detailTask map[string]json.RawMessage
	if err := json.Unmarshal(detail["task"], &detailTask); err != nil {
		t.Fatalf("decode task detail: %v", err)
	}
	if _, ok := detailTask["reference_availability"]; ok {
		t.Fatalf("availability leaked into detail: %s", body)
	}
	var projection struct {
		ReferenceMaterials []*struct {
			ID       string `json:"id"`
			FileName string `json:"file_name"`
			Kind     string `json:"kind"`
		} `json:"reference_materials"`
	}
	if err := json.Unmarshal(body, &projection); err != nil || projection.ReferenceMaterials == nil || len(projection.ReferenceMaterials) != 4 {
		t.Fatalf("detail must project four frozen positions: %s (decode error=%v)", body, err)
	}
	if projection.ReferenceMaterials[0] != nil || projection.ReferenceMaterials[1] != nil ||
		projection.ReferenceMaterials[2] != nil || projection.ReferenceMaterials[3] != nil {
		t.Fatalf("detail projected wrong current materials: %+v", projection.ReferenceMaterials)
	}
	view := decodeTaskView(t, body)
	if view.Task.UpdatedAt != updatedAt || view.Specification == nil || len(view.Specification.References) != 4 ||
		view.Specification.References[0].MaterialID != available ||
		view.Specification.References[1].MaterialID != missingRow ||
		view.Specification.References[2].MaterialID != missingRetention ||
		view.Specification.References[3].MaterialID != available {
		t.Fatalf("detail lost frozen specification or changed updated_at: %s", body)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/materials/"+missingRetention+"/preview-url", token, nil); status != http.StatusOK {
		t.Fatalf("independent material access status=%d", status)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/materials/"+available+"/thumbnail-url", token, nil); status != http.StatusNotFound {
		t.Fatalf("removed thumbnail status=%d", status)
	}
	if status, body := h.doRequest(t, http.MethodGet, path, foreign, nil); status != http.StatusOK {
		t.Fatalf("foreign list status=%d body=%s", status, body)
	} else {
		var foreignPage struct {
			Tasks []json.RawMessage `json:"tasks"`
		}
		if err := json.Unmarshal(body, &foreignPage); err != nil || len(foreignPage.Tasks) != 0 {
			t.Fatalf("foreign task list must be empty: %s (decode error=%v)", body, err)
		}
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/tasks/"+taskID, foreign, nil); status != http.StatusNotFound {
		t.Fatalf("foreign task detail status=%d", status)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `INSERT INTO creation_generation_task_references (task_id, material_id) VALUES ($1::uuid, $2::uuid)`, taskID, missingRetention); err != nil {
		t.Fatalf("restore retention: %v", err)
	}
	if after, got := read(); after != updatedAt || !reflect.DeepEqual(got, []bool{false, false, true, false}) {
		t.Fatalf("reloaded availability after restore: updated_at=%q availability=%v", after, got)
	}
}

func TestDismissedTaskCannotProjectOrAuthorizeStaleRetainedMaterial(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{runWorkers: true})
	token := h.loginToken(t, creator, harnessPassword)
	intent := h.imageTaskIntent(t, token, "Dismissed reference", 1)
	retained := h.uploadImage(t, token, intent.SessionID, "retained.png")
	independent := h.uploadImage(t, token, intent.SessionID, "independent.png")
	intent.Mode = "reference-image"
	intent.References = []any{map[string]any{"material_id": retained, "role": "reference"}}
	status, body := h.submitTask(t, token, "dismissed-reference-projection", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit referenced task: status=%d body=%s", status, body)
	}
	taskID := decodeTaskView(t, body).Task.ID
	h.awaitTaskTerminal(t, token, taskID)
	if status, body := h.dismissTask(t, token, taskID); status != http.StatusOK {
		t.Fatalf("dismiss task: status=%d body=%s", status, body)
	}
	// Simulate a stale historical relation, with no independent live material grant.
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_reference_materials SET removed_at = now() WHERE id = $1::uuid`, retained); err != nil {
		t.Fatalf("hide retained material: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `INSERT INTO creation_generation_task_references (task_id, material_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, taskID, retained); err != nil {
		t.Fatalf("restore stale relation: %v", err)
	}
	status, body = h.doRequest(t, http.MethodGet, "/creation/tasks/"+taskID, token, nil)
	if status != http.StatusOK {
		t.Fatalf("dismissed task detail: status=%d body=%s", status, body)
	}
	assertContractResponse(t, http.MethodGet, "/creation/tasks/"+taskID, status, body)
	var detail struct {
		ReferenceMaterials []json.RawMessage `json:"reference_materials"`
	}
	if err := json.Unmarshal(body, &detail); err != nil || len(detail.ReferenceMaterials) != 1 || string(detail.ReferenceMaterials[0]) != "null" {
		t.Fatalf("dismissed detail must retain frozen position without material: %s (decode error=%v)", body, err)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/materials/"+retained+"/thumbnail-url", token, nil); status != http.StatusNotFound {
		t.Fatalf("dismissed task still authorized retained thumbnail: %d", status)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/materials/"+independent+"/thumbnail-url", token, nil); status != http.StatusOK {
		t.Fatalf("independently active material became unreadable: %d", status)
	}
}
