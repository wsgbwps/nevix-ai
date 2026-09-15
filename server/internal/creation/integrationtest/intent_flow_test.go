package integrationtest

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
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

// Composer removal and frozen task references have independent lifecycles:
// removal hides the material from future admission while the owning task can
// keep refreshing its short-lived thumbnail grant from the retained identity.
func TestRemovedMaterialRemainsAvailableToItsFrozenTask(t *testing.T) {
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	now := func() time.Time { return time.Unix(0, clock.Load()) }
	h, _, creator := readyTaskHarness(t, harnessOptions{now: now})
	token := h.loginToken(t, creator, harnessPassword)
	otherToken := h.loginToken(t, otherCreatorEmail, harnessPassword)

	session := h.createSession(t, token, sessionName("retained-reference"))
	materialID := h.uploadImage(t, token, session.ID, "retained.png")
	intent := h.buildTaskIntent(t, token, session.ID, taskIntent{
		MediaType: "image", Model: "doubao-seedream-5.0-pro", Mode: "reference-image",
		Ratio: "1:1", Resolution: "2K", Quantity: 1, Prompt: "引用已移出素材",
		References: []any{map[string]any{"material_id": materialID, "role": "reference"}},
	})
	status, body := h.submitTask(t, token, "retained-reference-key", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit retained reference: status=%d body=%s", status, body)
	}

	type thumbnailGrant struct {
		URL       string    `json:"url"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	authorize := func() thumbnailGrant {
		t.Helper()
		status, body := h.doRequest(t, http.MethodGet, "/creation/materials/"+materialID+"/thumbnail-url", token, nil)
		if status != http.StatusOK {
			t.Fatalf("authorize retained thumbnail: status=%d body=%s", status, body)
		}
		var grant thumbnailGrant
		mustDecode(t, body, &grant)
		return grant
	}
	firstURL := authorize()

	var objectKey string
	if err := h.ownerPool.QueryRow(h.ctx,
		`SELECT blob_key FROM creation_reference_materials WHERE id = $1::uuid`, materialID,
	).Scan(&objectKey); err != nil {
		t.Fatalf("read retained object key: %v", err)
	}

	if status, body := h.doRequest(t, "DELETE", "/creation/materials/"+materialID, token, nil); status != http.StatusNoContent {
		t.Fatalf("delete material: status=%d body=%s", status, body)
	}
	status, body = h.doRequest(t, http.MethodGet, "/creation/sessions/"+session.ID+"/materials", token, nil)
	if status != http.StatusOK {
		t.Fatalf("list materials after removal: status=%d body=%s", status, body)
	}
	var listing materialList
	mustDecode(t, body, &listing)
	if len(listing.Materials) != 0 {
		t.Fatalf("removed material remains in Composer listing: %+v", listing.Materials)
	}
	if status, body := h.submitTask(t, token, "removed-reference-key", intent); status != http.StatusBadRequest {
		t.Fatalf("removed reference must be invalid_request, got %d: %s", status, body)
	} else {
		assertErrorCode(t, body, "invalid_request")
	}
	clock.Store(firstURL.ExpiresAt.Add(time.Minute).UnixNano())
	secondURL := authorize()
	if secondURL.URL == firstURL.URL || !secondURL.ExpiresAt.After(now()) {
		t.Fatalf("thumbnail refresh after expiry did not issue a fresh grant: %+v", secondURL)
	}
	if status, body := h.doRequest(t, http.MethodGet, "/creation/materials/"+materialID+"/thumbnail-url", otherToken, nil); status != http.StatusNotFound {
		t.Fatalf("foreign retained thumbnail authorization: status=%d body=%s", status, body)
	}
	if _, err := h.directStore.Head(h.ctx, objectKey); err != nil {
		t.Fatalf("retained task reference lost its exact object: %v", err)
	}
	for _, suffix := range []string{"", "/preview-url"} {
		if status, body := h.doRequest(t, http.MethodGet, "/creation/materials/"+materialID+suffix, token, nil); status != http.StatusNotFound {
			t.Fatalf("removed material became active-readable at %s: status=%d body=%s", suffix, status, body)
		}
	}
	if status, body := h.doRequest(t, http.MethodDelete, "/creation/sessions/"+session.ID, token, nil); status != http.StatusNoContent {
		t.Fatalf("delete retaining task session: status=%d body=%s", status, body)
	}
	if grant := authorize(); grant.URL == secondURL.URL {
		t.Fatal("session removal prevented a fresh task reference grant")
	}
}

func TestAdmittedTaskUsesItsReferenceAfterComposerRemoval(t *testing.T) {
	h, _, creator := readyTaskHarness(t, harnessOptions{})
	token := h.loginToken(t, creator, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})
	session := h.createSession(t, token, sessionName("removed-reference-worker"))
	materialID := h.uploadImage(t, token, session.ID, "worker-reference.png")
	intent := h.buildTaskIntent(t, token, session.ID, taskIntent{
		MediaType: "image", Model: "doubao-seedream-5.0-pro", Mode: "reference-image",
		Ratio: "1:1", Resolution: "2K", Quantity: 1, Prompt: "提交后独立执行",
		References: []any{map[string]any{"material_id": materialID, "role": "reference"}},
	})
	status, body := h.submitTask(t, token, "removed-reference-worker-key", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit retaining task: status=%d body=%s", status, body)
	}
	taskID := decodeTaskView(t, body).Task.ID
	if status, body := h.doRequest(t, http.MethodDelete, "/creation/materials/"+materialID, token, nil); status != http.StatusNoContent {
		t.Fatalf("remove Composer material: status=%d body=%s", status, body)
	}

	workerCtx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.creation.RunWorkers(workerCtx) }()
	view := h.awaitTaskTerminal(t, token, taskID)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("stop worker: %v", err)
	}
	if view.Task.Status != "succeeded" {
		t.Fatalf("Composer removal changed an admitted task: status=%s slots=%s", view.Task.Status, slotVerdicts(view))
	}
	if call := h.kapon.generation.lastImageCall(); call == nil || call.images != 1 {
		t.Fatalf("worker lost the frozen reference: %+v", call)
	}
}
