package integrationtest

import (
	"net/http"
	"strings"
	"testing"
)

// Draft wire shapes mirroring contracts/creation.yaml SessionDraft /
// CreationSessionDetail.
type draftReferenceView struct {
	MaterialID string `json:"material_id"`
	Role       string `json:"role"`
}

type draftView struct {
	Prompt          string               `json:"prompt"`
	MediaType       *string              `json:"media_type"`
	ManifestVersion int                  `json:"manifest_version"`
	Model           *string              `json:"model"`
	Mode            *string              `json:"mode"`
	Ratio           *string              `json:"ratio"`
	Resolution      *string              `json:"resolution"`
	Quantity        *int                 `json:"quantity"`
	DurationSeconds *int                 `json:"duration_seconds"`
	References      []draftReferenceView `json:"references"`
}

type sessionDetailView struct {
	sessionView
	Draft *draftView `json:"draft"`
}

func (h *harness) saveDraft(t *testing.T, token, sessionID string, draft map[string]any) (int, []byte) {
	t.Helper()
	return h.doRequest(t, "PUT", "/creation/sessions/"+sessionID+"/draft", token, draft)
}

func (h *harness) getSessionDetail(t *testing.T, token, sessionID string) (int, sessionDetailView) {
	t.Helper()
	status, body := h.doRequest(t, "GET", "/creation/sessions/"+sessionID, token, nil)
	if status != http.StatusOK {
		t.Fatalf("get session detail: status=%d body=%s", status, body)
	}
	var view sessionDetailView
	mustDecode(t, body, &view)
	assertContractResponse(t, "GET", "/creation/sessions/"+sessionID, status, body)
	return status, view
}

func fullDraftInput(materialIDs ...string) map[string]any {
	mediaType := "image"
	model := "doubao-seedream-5.0-pro"
	mode := "reference-image"
	ratio := "4:3"
	resolution := "2K"
	quantity := 2
	manifestVersion := 3
	refs := make([]map[string]any, 0, len(materialIDs))
	for _, id := range materialIDs {
		refs = append(refs, map[string]any{"material_id": id, "role": "reference"})
	}
	return map[string]any{
		"prompt":           "夏季跑鞋主图，暖光背景",
		"media_type":       mediaType,
		"manifest_version": manifestVersion,
		"model":            model,
		"mode":             mode,
		"ratio":            ratio,
		"resolution":       resolution,
		"quantity":         quantity,
		"duration_seconds": nil,
		"references":       refs,
	}
}

func (h *harness) uploadImage(t *testing.T, token, sessionID, name string) string {
	t.Helper()
	status, body := h.doUpload(t, "POST", "/creation/sessions/"+sessionID+"/materials", token, name, pngBytes(t))
	if status != http.StatusCreated {
		t.Fatalf("upload material %s: status=%d body=%s", name, status, body)
	}
	return extractField(t, body, "id")
}

// A saved draft must round-trip verbatim — prompt, media, manifest version,
// model/mode/parameters, and the ordered reference identity/role list — so a
// reload restores the creator's intent exactly (issue #177).
func TestDraftSaveAndRecoverRoundTrip(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("draft-roundtrip"))

	// A never-saved session answers draft: null.
	_, fresh := h.getSessionDetail(t, token, session.ID)
	if fresh.Draft != nil {
		t.Fatalf("fresh session must carry a null draft, got %+v", fresh.Draft)
	}

	first := h.uploadImage(t, token, session.ID, "first.png")
	second := h.uploadImage(t, token, session.ID, "second.png")

	status, body := h.saveDraft(t, token, session.ID, fullDraftInput(first, second))
	if status != http.StatusOK {
		t.Fatalf("save draft: status=%d body=%s", status, body)
	}
	assertContractResponse(t, "PUT", "/creation/sessions/{sessionID}/draft", status, body)

	_, recovered := h.getSessionDetail(t, token, session.ID)
	if recovered.Draft == nil {
		t.Fatal("draft vanished after save")
	}
	if recovered.Draft.Prompt != "夏季跑鞋主图，暖光背景" {
		t.Fatalf("prompt lost: %+v", recovered.Draft)
	}
	if recovered.Draft.MediaType == nil || *recovered.Draft.MediaType != "image" {
		t.Fatalf("media type lost: %+v", recovered.Draft)
	}
	if recovered.Draft.ManifestVersion != 3 {
		t.Fatalf("manifest version lost: %+v", recovered.Draft)
	}
	if recovered.Draft.Model == nil || *recovered.Draft.Model != "doubao-seedream-5.0-pro" {
		t.Fatalf("model lost: %+v", recovered.Draft)
	}
	if recovered.Draft.Mode == nil || *recovered.Draft.Mode != "reference-image" {
		t.Fatalf("mode lost: %+v", recovered.Draft)
	}
	if recovered.Draft.Ratio == nil || *recovered.Draft.Ratio != "4:3" {
		t.Fatalf("ratio lost: %+v", recovered.Draft)
	}
	if recovered.Draft.Quantity == nil || *recovered.Draft.Quantity != 2 {
		t.Fatalf("quantity lost: %+v", recovered.Draft)
	}
	if recovered.Draft.DurationSeconds != nil {
		t.Fatalf("image draft must not carry a duration: %+v", recovered.Draft)
	}
	if len(recovered.Draft.References) != 2 ||
		recovered.Draft.References[0].MaterialID != first ||
		recovered.Draft.References[1].MaterialID != second ||
		recovered.Draft.References[0].Role != "reference" {
		t.Fatalf("ordered references lost: %+v", recovered.Draft.References)
	}

	// Re-saving with the reversed order must flip the recovered order — the
	// binding list is replaced atomically, never appended to.
	reversed := fullDraftInput(second, first)
	if status, body := h.saveDraft(t, token, session.ID, reversed); status != http.StatusOK {
		t.Fatalf("resave draft: status=%d body=%s", status, body)
	}
	_, flipped := h.getSessionDetail(t, token, session.ID)
	if len(flipped.Draft.References) != 2 || flipped.Draft.References[0].MaterialID != second {
		t.Fatalf("reference order not replaced: %+v", flipped.Draft.References)
	}
}

// The draft is part of the creator-private session: every other principal —
// member or admin, real or fabricated id, before or after deletion — fails
// closed with the same 404 as any other session access.
func TestDraftIsCreatorPrivateFailClosed(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	adminToken := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	creatorToken := h.loginToken(t, creatorEmail, harnessPassword)
	otherToken := h.loginToken(t, otherCreatorEmail, harnessPassword)

	session := h.createSession(t, creatorToken, sessionName("draft-private"))
	if status, body := h.saveDraft(t, adminToken, session.ID, fullDraftInput()); status != http.StatusNotFound {
		t.Fatalf("admin save draft: status=%d body=%s", status, body)
	}
	if status, body := h.saveDraft(t, otherToken, session.ID, fullDraftInput()); status != http.StatusNotFound {
		t.Fatalf("other member save draft: status=%d body=%s", status, body)
	}
	if status, body := h.doRequest(t, "GET", "/creation/sessions/"+session.ID, otherToken, nil); status != http.StatusNotFound {
		t.Fatalf("other member read draft: status=%d body=%s", status, body)
	}

	fabricated := "11111111-2222-3333-4444-555555555555"
	if status, _ := h.saveDraft(t, creatorToken, fabricated, fullDraftInput()); status != http.StatusNotFound {
		t.Fatalf("fabricated id save draft: status=%d", status)
	}

	// Deleting the session removes every draft path with it.
	if status, _ := h.saveDraft(t, creatorToken, session.ID, fullDraftInput()); status != http.StatusOK {
		t.Fatalf("save before delete: status=%d", status)
	}
	if status, _ := h.doRequest(t, "DELETE", "/creation/sessions/"+session.ID, creatorToken, nil); status != http.StatusNoContent {
		t.Fatalf("delete session: status=%d", status)
	}
	if status, _ := h.saveDraft(t, creatorToken, session.ID, fullDraftInput()); status != http.StatusNotFound {
		t.Fatalf("save draft after session delete: status=%d", status)
	}
	if status, body := h.doRequest(t, "GET", "/creation/sessions/"+session.ID, creatorToken, nil); status != http.StatusNotFound {
		t.Fatalf("read draft after session delete: status=%d body=%s", status, body)
	}
}

// A failed save must leave no partial update: the previously stored draft
// survives byte-for-byte, including its reference bindings.
func TestDraftSaveFailureLeavesPriorDraftIntact(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	otherToken := h.loginToken(t, otherCreatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("draft-atomic"))
	otherSession := h.createSession(t, otherToken, sessionName("draft-atomic-other"))

	own := h.uploadImage(t, token, session.ID, "own.png")
	foreign := h.uploadImage(t, otherToken, otherSession.ID, "foreign.png")

	if status, _ := h.saveDraft(t, token, session.ID, fullDraftInput(own)); status != http.StatusOK {
		t.Fatalf("seed draft: status=%d", status)
	}

	// A reference to another session's material violates the envelope.
	foreignDraft := fullDraftInput(foreign)
	if status, body := h.saveDraft(t, token, session.ID, foreignDraft); status != http.StatusBadRequest {
		t.Fatalf("foreign material reference: status=%d body=%s", status, body)
	}
	// An omni-role audio binding violates role/kind compatibility.
	audioStatus, audioBody := h.doUpload(t, "POST", "/creation/sessions/"+session.ID+"/materials", token, "clip.m4a", audioOnlyMP4Fixture(1<<20))
	if audioStatus != http.StatusCreated {
		t.Fatalf("upload audio: status=%d audioBody=%s", audioStatus, audioBody)
	}
	audioID := extractField(t, audioBody, "id")
	mismatched := fullDraftInput(audioID)
	if status, body := h.saveDraft(t, token, session.ID, mismatched); status != http.StatusBadRequest {
		t.Fatalf("role-kind mismatch: status=%d body=%s", status, body)
	}

	_, unchanged := h.getSessionDetail(t, token, session.ID)
	if unchanged.Draft == nil || len(unchanged.Draft.References) != 1 || unchanged.Draft.References[0].MaterialID != own {
		t.Fatalf("failed saves left a partial draft: %+v", unchanged.Draft)
	}

	// Omni roles accept every material kind, so the audio binding lands.
	omni := map[string]any{
		"prompt":           "全能参考视频",
		"media_type":       "video",
		"manifest_version": 1,
		"model":            "doubao-seedance-2-5",
		"mode":             "omni-reference",
		"resolution":       "720p",
		"duration_seconds": 5,
		"references":       []map[string]any{{"material_id": audioID, "role": "omni"}},
	}
	if status, body := h.saveDraft(t, token, session.ID, omni); status != http.StatusOK {
		t.Fatalf("omni save: status=%d body=%s", status, body)
	}
	_, updated := h.getSessionDetail(t, token, session.ID)
	if len(updated.Draft.References) != 1 || updated.Draft.References[0].Role != "omni" {
		t.Fatalf("omni binding lost: %+v", updated.Draft.References)
	}
}

// Deleting a material removes its draft binding: the material lifecycle rule
// does not drift now that drafts reference material identities.
func TestMaterialDeleteRemovesDraftBinding(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("draft-material-delete"))

	kept := h.uploadImage(t, token, session.ID, "kept.png")
	doomed := h.uploadImage(t, token, session.ID, "doomed.png")
	if status, _ := h.saveDraft(t, token, session.ID, fullDraftInput(kept, doomed)); status != http.StatusOK {
		t.Fatalf("save draft: status=%d", status)
	}

	if status, body := h.doRequest(t, "DELETE", "/creation/materials/"+doomed, token, nil); status != http.StatusNoContent {
		t.Fatalf("delete material: status=%d body=%s", status, body)
	}
	_, after := h.getSessionDetail(t, token, session.ID)
	if len(after.Draft.References) != 1 || after.Draft.References[0].MaterialID != kept {
		t.Fatalf("deleted material binding survived: %+v", after.Draft.References)
	}
}

// Values the current manifest no longer publishes must round-trip untouched:
// the server deliberately does not consult the capability manifest here.
func TestDraftPreservesStaleManifestValues(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)
	session := h.createSession(t, token, sessionName("draft-stale-values"))

	stale := map[string]any{
		"prompt":           "保留已移除能力的历史草稿",
		"media_type":       "video",
		"manifest_version": 1,
		"model":            "removed-legacy-model",
		"mode":             "removed-legacy-mode",
		"ratio":            "7:3",
		"resolution":       "2160p-removed",
		"quantity":         4,
		"duration_seconds": 15,
		"references":       []map[string]any{},
	}
	if status, body := h.saveDraft(t, token, session.ID, stale); status != http.StatusOK {
		t.Fatalf("stale save: status=%d body=%s", status, body)
	}
	_, recovered := h.getSessionDetail(t, token, session.ID)
	if recovered.Draft.Model == nil || *recovered.Draft.Model != "removed-legacy-model" {
		t.Fatalf("stale model rewritten: %+v", recovered.Draft)
	}
	if recovered.Draft.Mode == nil || *recovered.Draft.Mode != "removed-legacy-mode" {
		t.Fatalf("stale mode rewritten: %+v", recovered.Draft)
	}
	if recovered.Draft.Resolution == nil || *recovered.Draft.Resolution != "2160p-removed" {
		t.Fatalf("stale resolution rewritten: %+v", recovered.Draft)
	}
	if len(recovered.Draft.References) != 0 {
		t.Fatalf("empty references must persist: %+v", recovered.Draft.References)
	}

	// Structural violations still reject: unknown media type, out-of-range
	// quantity, over-long prompt.
	if status, _ := h.saveDraft(t, token, session.ID, map[string]any{
		"prompt": "x", "media_type": "audio", "manifest_version": 1, "references": []map[string]any{},
	}); status != http.StatusBadRequest {
		t.Fatalf("unknown media type: status=%d", status)
	}
	if status, _ := h.saveDraft(t, token, session.ID, map[string]any{
		"prompt": "x", "media_type": "image", "manifest_version": 1, "quantity": 5, "references": []map[string]any{},
	}); status != http.StatusBadRequest {
		t.Fatalf("quantity out of range: status=%d", status)
	}
	if status, _ := h.saveDraft(t, token, session.ID, map[string]any{
		"prompt": strings.Repeat("啊", 2001), "media_type": "image", "manifest_version": 1, "references": []map[string]any{},
	}); status != http.StatusBadRequest {
		t.Fatalf("over-long prompt: status=%d", status)
	}
	// The 2000th rune boundary stays legal.
	if status, _ := h.saveDraft(t, token, session.ID, map[string]any{
		"prompt": strings.Repeat("啊", 2000), "media_type": "image", "manifest_version": 1, "references": []map[string]any{},
	}); status != http.StatusOK {
		t.Fatalf("2000-rune prompt must save: status=%d", status)
	}
}
