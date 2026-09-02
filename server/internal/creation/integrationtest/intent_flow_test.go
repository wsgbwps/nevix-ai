package integrationtest

import (
	"encoding/json"
	"net/http"
	"testing"
)

// Intent submission flow (ADR-0017): the server stores no editable draft —
// submission carries the full generation intent and the session surface has
// no draft field or route.

func (h *harness) uploadImage(t *testing.T, token, sessionID, name string) string {
	t.Helper()
	status, body := h.doUpload(t, "POST", "/creation/sessions/"+sessionID+"/materials", token, name, pngBytes(t))
	if status != http.StatusCreated {
		t.Fatalf("upload material %s: status=%d body=%s", name, status, body)
	}
	return extractField(t, body, "id")
}

func (h *harness) uploadAudio(t *testing.T, token, sessionID string) string {
	t.Helper()
	status, body := h.doUpload(t, "POST", "/creation/sessions/"+sessionID+"/materials", token, "clip.m4a", audioOnlyMP4Fixture(1<<20))
	if status != http.StatusCreated {
		t.Fatalf("upload audio: status=%d body=%s", status, body)
	}
	return extractField(t, body, "id")
}

// A submission must freeze exactly the intent the request carried: prompt,
// media, model/mode/parameters, and the ordered reference identity/role list.
func TestSubmitCarriesFullIntent(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)

	session := h.createSession(t, token, sessionName("intent-freeze"))
	first := h.uploadImage(t, token, session.ID, "first.png")
	second := h.uploadImage(t, token, session.ID, "second.png")

	intent := h.buildTaskIntent(t, token, session.ID, taskIntent{
		MediaType: "image", Model: "doubao-seedream-5.0-pro", Mode: "reference-image",
		Ratio: "4:3", Resolution: "2K", Quantity: 2, Prompt: "夏季跑鞋主图，暖光背景",
		References: []any{
			map[string]any{"material_id": first, "role": "reference"},
			map[string]any{"material_id": second, "role": "reference"},
		},
	})
	status, body := h.submitTask(t, token, "intent-freeze-key", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit: status=%d body=%s", status, body)
	}
	assertContractResponse(t, "POST", "/creation/sessions/"+session.ID+"/tasks", status, body)

	view := decodeTaskView(t, body)
	if view.Specification == nil {
		t.Fatal("admitted task must carry the frozen specification")
	}
	// The admitted task would otherwise stay active in the shared database and
	// trip later scenarios' no-active-task expectations; cancel converges it.
	taskID := view.Task.ID
	if status, body := h.doRequest(t, "POST", "/creation/tasks/"+taskID+"/cancel", token, nil); status != http.StatusOK {
		t.Fatalf("cancel admitted task: status=%d body=%s", status, body)
	}
	spec := *view.Specification
	if spec.Prompt != "夏季跑鞋主图，暖光背景" || spec.Model != "doubao-seedream-5.0-pro" ||
		spec.Mode != "reference-image" || spec.Ratio == nil || *spec.Ratio != "4:3" ||
		spec.Resolution == nil || *spec.Resolution != "2K" || spec.Quantity != 2 {
		t.Fatalf("frozen specification lost intent values: %+v", spec)
	}
	if len(spec.References) != 2 ||
		spec.References[0].MaterialID != first || spec.References[1].MaterialID != second ||
		spec.References[0].Role != "reference" {
		t.Fatalf("ordered references lost: %+v", spec.References)
	}
}

// The session surface has no stored draft: the detail response carries no
// draft field and the draft route is gone entirely (ADR-0017).
func TestSessionSurfaceHasNoStoredDraft(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("no-stored-draft"))

	status, body := h.doRequest(t, "GET", "/creation/sessions/"+session.ID, token, nil)
	if status != http.StatusOK {
		t.Fatalf("get session: status=%d body=%s", status, body)
	}
	assertContractResponse(t, "GET", "/creation/sessions/"+session.ID, status, body)
	var detail map[string]any
	if err := json.Unmarshal(body, &detail); err != nil {
		t.Fatalf("decode session detail: %v", err)
	}
	if _, hasDraft := detail["draft"]; hasDraft {
		t.Fatal("session detail must not carry a draft field")
	}

	if status, body := h.doRequest(t, "PUT", "/creation/sessions/"+session.ID+"/draft", token,
		map[string]any{"prompt": "x", "media_type": "image", "manifest_version": 1, "references": []any{}}); status != http.StatusNotFound {
		t.Fatalf("the draft route must be gone, got %d: %s", status, body)
	}
}

// Deleting a material must fail a submission that still references it: the
// reference facts are re-verified inside the admission transaction.
func TestMaterialDeleteRejectsDanglingReference(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)

	session := h.createSession(t, token, sessionName("dangling-reference"))
	doomed := h.uploadImage(t, token, session.ID, "doomed.png")
	intent := h.buildTaskIntent(t, token, session.ID, taskIntent{
		MediaType: "image", Model: "doubao-seedream-5.0-pro", Mode: "reference-image",
		Ratio: "1:1", Resolution: "2K", Quantity: 1, Prompt: "引用已删除素材",
		References: []any{map[string]any{"material_id": doomed, "role": "reference"}},
	})

	if status, body := h.doRequest(t, "DELETE", "/creation/materials/"+doomed, token, nil); status != http.StatusNoContent {
		t.Fatalf("delete material: status=%d body=%s", status, body)
	}
	if status, body := h.submitTask(t, token, "dangling-key", intent); status != http.StatusBadRequest {
		t.Fatalf("dangling reference must be invalid_request, got %d: %s", status, body)
	} else {
		assertErrorCode(t, body, "invalid_request")
	}
}
