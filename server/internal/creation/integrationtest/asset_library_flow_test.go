package integrationtest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"testing"
	"time"
)

type assetLibraryResource struct {
	ID        string `json:"id"`
	MediaType string `json:"media_type"`
	Creator   struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
	} `json:"creator"`
	Capabilities struct {
		CanDelete        bool `json:"can_delete"`
		CanCreateSimilar bool `json:"can_create_similar"`
		CanPublish       bool `json:"can_publish"`
	} `json:"capabilities"`
}

type publicationDetailView struct {
	Specification struct {
		References []struct {
			MaterialID string `json:"material_id"`
		} `json:"references"`
	} `json:"specification"`
	References []struct {
		ID string `json:"id"`
	} `json:"references"`
}

type adminPublicationStateView struct {
	Asset struct {
		Restricted       bool    `json:"restricted"`
		RestrictionState *string `json:"restriction_state"`
		Publication      *struct {
			ID               string  `json:"id"`
			Restricted       bool    `json:"restricted"`
			RestrictionState *string `json:"restriction_state"`
		} `json:"publication"`
	} `json:"asset"`
	Publication *struct {
		ID               string  `json:"id"`
		Restricted       bool    `json:"restricted"`
		RestrictionState *string `json:"restriction_state"`
		Capabilities     struct {
			CanWithdraw      bool `json:"can_withdraw"`
			CanCreateSimilar bool `json:"can_create_similar"`
			CanRestrict      bool `json:"can_restrict"`
			CanRelease       bool `json:"can_release"`
		} `json:"capabilities"`
	} `json:"publication"`
}

type similarCreationView struct {
	Session struct {
		ID string `json:"id"`
	} `json:"session"`
	Materials []struct {
		ID        string `json:"id"`
		SessionID string `json:"session_id"`
	} `json:"materials"`
	Specification struct {
		References []struct {
			MaterialID string `json:"material_id"`
		} `json:"references"`
	} `json:"specification"`
}

func TestAssetLibraryPublicationInspirationAndCreateSimilar(t *testing.T) {
	h, adminToken, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creatorToken := h.loginToken(t, creatorEmailAddress, harnessPassword)
	otherToken := h.loginToken(t, otherCreatorEmail, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})
	createdSince := url.QueryEscape(time.Now().UTC().Format(time.RFC3339Nano))
	intent := h.imageTaskIntent(t, creatorToken, "Asset Library private prompt", 2)
	sourceReferenceID := h.uploadImage(t, creatorToken, intent.SessionID, "publication-reference.png")
	intent.Mode = "reference-image"
	intent.References = []any{map[string]any{"material_id": sourceReferenceID, "role": "reference"}}
	status, body := h.submitTask(t, creatorToken, "asset-library-flow", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := h.awaitTaskTerminal(t, creatorToken, decodeTaskView(t, body).Task.ID)
	if view.Task.Status != "succeeded" {
		t.Fatalf("task status=%s", view.Task.Status)
	}
	storedObjects := h.directStore.objectCount()
	preparedReferences := len(h.referenceTransport.prepared())

	creatorPage := readAssetPage(t, h, creatorToken, "/creation/assets?limit=1&media_type=image&sort=newest&created_since="+createdSince)
	if len(creatorPage.Assets) != 1 || creatorPage.NextCursor == nil {
		t.Fatalf("creator first page=%+v", creatorPage)
	}
	first := creatorPage.Assets[0]
	if !first.Capabilities.CanDelete || !first.Capabilities.CanCreateSimilar {
		t.Fatalf("creator capabilities=%+v", first.Capabilities)
	}
	secondPage := readAssetPage(t, h, creatorToken, "/creation/assets?limit=1&created_since="+createdSince+"&cursor="+*creatorPage.NextCursor)
	if len(secondPage.Assets) != 1 || secondPage.NextCursor != nil || secondPage.Assets[0].ID == first.ID {
		t.Fatalf("creator second page=%+v", secondPage)
	}
	second := secondPage.Assets[0]

	for name, token := range map[string]string{"member": otherToken, "admin": adminToken} {
		page := readAssetPage(t, h, token, "/creation/assets?search="+first.ID)
		if len(page.Assets) != 0 {
			t.Fatalf("%s saw foreign private assets=%+v", name, page)
		}
		status, detailBody := h.doRequest(t, http.MethodGet, "/creation/assets/"+first.ID, token, nil)
		if status != http.StatusNotFound || bytes.Contains(detailBody, []byte("private prompt")) {
			t.Fatalf("%s foreign detail: status=%d body=%s", name, status, detailBody)
		}
	}
	status, detailBody := h.doRequest(t, http.MethodGet, "/creation/assets/"+first.ID, creatorToken, nil)
	if status != http.StatusOK || !bytes.Contains(detailBody, []byte("private_origin")) || !bytes.Contains(detailBody, []byte("Asset Library private prompt")) {
		t.Fatalf("creator detail missed private origin: status=%d body=%s", status, detailBody)
	}
	if !bytes.Contains(detailBody, []byte(sourceReferenceID)) {
		t.Fatalf("creator detail missed the actual ordered reference: %s", detailBody)
	}
	status, adminDetailBody := h.doRequest(t, http.MethodGet, "/creation/inspiration/assets/"+first.ID, adminToken, nil)
	if status != http.StatusOK || !bytes.Contains(adminDetailBody, []byte(sourceReferenceID)) ||
		bytes.Contains(adminDetailBody, []byte(`"session_id"`)) || bytes.Contains(adminDetailBody, []byte(`"task_id"`)) {
		t.Fatalf("narrow admin detail status=%d body=%s", status, adminDetailBody)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/inspiration/assets/"+first.ID, otherToken, nil); status != http.StatusForbidden {
		t.Fatalf("member admin-asset detail status=%d", status)
	}
	if status, previewBody := h.doRequest(t, http.MethodGet, "/creation/inspiration/assets/"+first.ID+"/references/"+sourceReferenceID+"/preview-url", adminToken, nil); status != http.StatusOK || !bytes.Contains(previewBody, []byte(`"url"`)) {
		t.Fatalf("admin exact reference preview status=%d body=%s", status, previewBody)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/materials/"+sourceReferenceID+"/preview-url", otherToken, nil); status != http.StatusNotFound {
		t.Fatalf("foreign raw reference preview status=%d", status)
	}

	whole := downloadAsset(t, h, creatorToken, second.ID, "")
	digest := sha256.Sum256(whole.body)
	if whole.status != http.StatusOK || whole.checksum != hex.EncodeToString(digest[:]) {
		t.Fatalf("team download status=%d checksum=%q", whole.status, whole.checksum)
	}
	partial := downloadAsset(t, h, creatorToken, second.ID, "bytes=0-15")
	if partial.status != http.StatusPartialContent || !bytes.Equal(partial.body, whole.body[:16]) || partial.contentRange != fmt.Sprintf("bytes 0-15/%d", len(whole.body)) {
		t.Fatalf("asset range status=%d range=%q len=%d", partial.status, partial.contentRange, len(partial.body))
	}

	if status, _ := h.doRequest(t, http.MethodDelete, "/creation/assets/"+first.ID, otherToken, nil); status != http.StatusNotFound {
		t.Fatalf("foreign member delete status=%d", status)
	}
	status, publishBody := h.doRequest(t, http.MethodPost, "/creation/assets/"+first.ID+"/publication", creatorToken, map[string]any{"idempotency_key": "publish-first"})
	if status != http.StatusCreated {
		t.Fatalf("publish status=%d body=%s", status, publishBody)
	}
	publicationID := extractNestedField(t, publishBody, "publication", "id")
	if h.directStore.objectCount() != storedObjects || len(h.referenceTransport.prepared()) != preparedReferences {
		t.Fatal("publish copied an output or reference object")
	}
	status, replayBody := h.doRequest(t, http.MethodPost, "/creation/assets/"+first.ID+"/publication", creatorToken, map[string]any{"idempotency_key": "publish-replay"})
	if status != http.StatusOK || extractNestedField(t, replayBody, "publication", "id") != publicationID {
		t.Fatalf("publish replay status=%d body=%s", status, replayBody)
	}
	status, memberInspiration := h.doRequest(t, http.MethodGet, "/creation/inspiration?search="+publicationID, otherToken, nil)
	if status != http.StatusOK || !bytes.Contains(memberInspiration, []byte(publicationID)) || bytes.Contains(memberInspiration, []byte(second.ID)) {
		t.Fatalf("member inspiration status=%d body=%s", status, memberInspiration)
	}
	status, adminInspiration := h.doRequest(t, http.MethodGet, "/creation/inspiration?search="+second.ID, adminToken, nil)
	if status != http.StatusOK || !bytes.Contains(adminInspiration, []byte(second.ID)) {
		t.Fatalf("admin inspiration status=%d body=%s", status, adminInspiration)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_media_assets SET restricted_at = now() WHERE id = $1::uuid`, second.ID); err != nil {
		t.Fatalf("restrict admin-delete fixture: %v", err)
	}
	if status, _ := h.doRequest(t, http.MethodDelete, "/creation/assets/"+second.ID, creatorToken, nil); status != http.StatusNotFound {
		t.Fatalf("creator restricted asset delete status=%d", status)
	}
	if status, body := h.doRequest(t, http.MethodDelete, "/creation/assets/"+second.ID, adminToken, nil); status != http.StatusNoContent {
		t.Fatalf("admin restricted asset delete status=%d body=%s", status, body)
	}
	status, publicationDetailBody := h.doRequest(t, http.MethodGet, "/creation/publications/"+publicationID, otherToken, nil)
	var publicationDetail publicationDetailView
	mustDecode(t, publicationDetailBody, &publicationDetail)
	if status != http.StatusOK || len(publicationDetail.Specification.References) != 1 || len(publicationDetail.References) != 1 {
		t.Fatalf("publication detail status=%d body=%s", status, publicationDetailBody)
	}
	snapshotReferenceID := publicationDetail.References[0].ID
	if snapshotReferenceID == sourceReferenceID || publicationDetail.Specification.References[0].MaterialID != snapshotReferenceID || bytes.Contains(publicationDetailBody, []byte(sourceReferenceID)) {
		t.Fatalf("publication did not replace private material identity with its snapshot: %s", publicationDetailBody)
	}
	if status, previewBody := h.doRequest(t, http.MethodGet, "/creation/publications/"+publicationID+"/references/"+snapshotReferenceID+"/preview-url", otherToken, nil); status != http.StatusOK || !bytes.Contains(previewBody, []byte(`"url"`)) {
		t.Fatalf("publication exact reference preview status=%d body=%s", status, previewBody)
	}
	status, similarBody := h.doRequest(t, http.MethodPost, "/creation/publications/"+publicationID+"/create-similar", otherToken, map[string]any{"idempotency_key": "similar-first"})
	if status != http.StatusCreated {
		t.Fatalf("create similar status=%d body=%s", status, similarBody)
	}
	var similar similarCreationView
	mustDecode(t, similarBody, &similar)
	similarSessionID := similar.Session.ID
	if len(similar.Materials) != 1 || len(similar.Specification.References) != 1 ||
		similar.Materials[0].SessionID != similarSessionID ||
		similar.Specification.References[0].MaterialID != similar.Materials[0].ID ||
		similar.Materials[0].ID == sourceReferenceID || similar.Materials[0].ID == snapshotReferenceID {
		t.Fatalf("create similar did not mint and remap one material alias: %s", similarBody)
	}
	if h.directStore.objectCount() != storedObjects || len(h.referenceTransport.prepared()) != preparedReferences {
		t.Fatal("create similar copied an output or reference object")
	}
	var sharesObject bool
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT source.blob_key = alias.blob_key
		FROM creation_reference_materials source
		JOIN creation_reference_materials alias ON alias.id = $2::uuid
		WHERE source.id = $1::uuid`, sourceReferenceID, similar.Materials[0].ID).Scan(&sharesObject); err != nil || !sharesObject {
		t.Fatalf("similar material object alias=%v err=%v", sharesObject, err)
	}
	status, similarReplay := h.doRequest(t, http.MethodPost, "/creation/publications/"+publicationID+"/create-similar", otherToken, map[string]any{"idempotency_key": "similar-first"})
	if status != http.StatusOK || extractNestedField(t, similarReplay, "session", "id") != similarSessionID {
		t.Fatalf("create similar replay status=%d body=%s", status, similarReplay)
	}
	var taskCount int
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT count(*) FROM creation_generation_tasks WHERE session_id = $1::uuid`, similarSessionID).Scan(&taskCount); err != nil || taskCount != 0 {
		t.Fatalf("similar session task count=%d err=%v", taskCount, err)
	}
	if status, _ := h.doRequest(t, http.MethodDelete, "/creation/publications/"+publicationID, otherToken, nil); status != http.StatusNotFound {
		t.Fatalf("foreign withdraw status=%d", status)
	}
	if status, _ := h.doRequest(t, http.MethodDelete, "/creation/publications/"+publicationID, creatorToken, nil); status != http.StatusNoContent {
		t.Fatalf("publisher withdraw status=%d", status)
	}
	if status, _ := h.doRequest(t, http.MethodPost, "/creation/publications/"+publicationID+"/create-similar", otherToken, map[string]any{"idempotency_key": "similar-after-withdraw"}); status != http.StatusNotFound {
		t.Fatalf("fresh reuse after withdrawal status=%d", status)
	}
	status, replayAfterWithdraw := h.doRequest(t, http.MethodPost, "/creation/publications/"+publicationID+"/create-similar", otherToken, map[string]any{"idempotency_key": "similar-first"})
	if status != http.StatusOK || extractNestedField(t, replayAfterWithdraw, "session", "id") != similarSessionID {
		t.Fatalf("durable replay after withdrawal status=%d body=%s", status, replayAfterWithdraw)
	}
	status, republishBody := h.doRequest(t, http.MethodPost, "/creation/assets/"+first.ID+"/publication", creatorToken, map[string]any{"idempotency_key": "publish-second"})
	secondPublicationID := extractNestedField(t, republishBody, "publication", "id")
	if status != http.StatusCreated || secondPublicationID == publicationID {
		t.Fatalf("republish status=%d body=%s", status, republishBody)
	}
	status, secondSimilarBody := h.doRequest(t, http.MethodPost, "/creation/publications/"+secondPublicationID+"/create-similar", otherToken, map[string]any{"idempotency_key": "similar-second"})
	if status != http.StatusCreated {
		t.Fatalf("second publication reuse status=%d body=%s", status, secondSimilarBody)
	}
	secondSimilarSessionID := extractNestedField(t, secondSimilarBody, "session", "id")
	if _, err := h.ownerPool.Exec(h.ctx, `
		UPDATE creation_team_publications
		SET restricted_at = now(), direct_restricted_at = now()
		WHERE id = $1::uuid`, secondPublicationID); err != nil {
		t.Fatalf("restrict publication fixture: %v", err)
	}
	status, restrictedDetailBody := h.doRequest(t, http.MethodGet, "/creation/inspiration/assets/"+first.ID, adminToken, nil)
	var restrictedDetail adminPublicationStateView
	mustDecode(t, restrictedDetailBody, &restrictedDetail)
	if status != http.StatusOK || restrictedDetail.Asset.Restricted || restrictedDetail.Asset.Publication == nil ||
		restrictedDetail.Asset.Publication.ID != secondPublicationID || !restrictedDetail.Asset.Publication.Restricted ||
		restrictedDetail.Publication == nil || !restrictedDetail.Publication.Restricted ||
		!restrictedDetail.Publication.Capabilities.CanWithdraw || restrictedDetail.Publication.Capabilities.CanCreateSimilar {
		t.Fatalf("admin publication restriction state status=%d detail=%+v body=%s", status, restrictedDetail, restrictedDetailBody)
	}
	if status, _ := h.doRequest(t, http.MethodPost, "/creation/publications/"+secondPublicationID+"/create-similar", otherToken, map[string]any{"idempotency_key": "similar-after-restriction"}); status != http.StatusNotFound {
		t.Fatalf("fresh reuse after restriction status=%d", status)
	}
	status, replayAfterRestriction := h.doRequest(t, http.MethodPost, "/creation/publications/"+secondPublicationID+"/create-similar", otherToken, map[string]any{"idempotency_key": "similar-second"})
	if status != http.StatusOK || extractNestedField(t, replayAfterRestriction, "session", "id") != secondSimilarSessionID {
		t.Fatalf("durable replay after restriction status=%d body=%s", status, replayAfterRestriction)
	}
	if status, _ := h.doRequest(t, http.MethodDelete, "/creation/publications/"+secondPublicationID, adminToken, nil); status != http.StatusNoContent {
		t.Fatalf("admin restricted-publication withdraw status=%d", status)
	}
	status, thirdPublishBody := h.doRequest(t, http.MethodPost, "/creation/assets/"+first.ID+"/publication", creatorToken, map[string]any{"idempotency_key": "publish-third"})
	thirdPublicationID := extractNestedField(t, thirdPublishBody, "publication", "id")
	if status != http.StatusCreated || thirdPublicationID == secondPublicationID {
		t.Fatalf("publish after restriction status=%d body=%s", status, thirdPublishBody)
	}
	var creatorID, creatorDisplayName string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT id::text, display_name FROM users WHERE email = $1`, creatorEmailAddress).Scan(&creatorID, &creatorDisplayName); err != nil {
		t.Fatalf("resolve creator id: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE users SET status = 'disabled' WHERE id = $1::uuid`, creatorID); err != nil {
		t.Fatalf("disable publisher fixture: %v", err)
	}
	if status, disabledPublisherBody := h.doRequest(t, http.MethodGet, "/creation/publications/"+thirdPublicationID, otherToken, nil); status != http.StatusOK || !bytes.Contains(disabledPublisherBody, []byte(creatorDisplayName)) {
		t.Fatalf("publication after publisher disable status=%d body=%s", status, disabledPublisherBody)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE users SET status = 'active' WHERE id = $1::uuid`, creatorID); err != nil {
		t.Fatalf("restore publisher fixture: %v", err)
	}
	if status, body := h.doRequest(t, http.MethodDelete, "/creation/assets/"+first.ID, creatorToken, nil); status != http.StatusNoContent {
		t.Fatalf("delete published source status=%d body=%s", status, body)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/publications/"+thirdPublicationID, otherToken, nil); status != http.StatusOK {
		t.Fatalf("publication after source deletion status=%d", status)
	}
	if status, deletedSourceInspiration := h.doRequest(t, http.MethodGet, "/creation/inspiration?search="+thirdPublicationID, adminToken, nil); status != http.StatusOK || !bytes.Contains(deletedSourceInspiration, []byte(thirdPublicationID)) {
		t.Fatalf("admin inspiration lost deleted-source publication status=%d body=%s", status, deletedSourceInspiration)
	}
	if status, _ := h.doRequest(t, http.MethodDelete, "/creation/publications/"+thirdPublicationID, adminToken, nil); status != http.StatusNoContent {
		t.Fatalf("admin withdraw status=%d", status)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/publications/"+thirdPublicationID, otherToken, nil); status != http.StatusNotFound {
		t.Fatalf("withdrawn publication status=%d", status)
	}
}

func extractNestedField(t *testing.T, body []byte, parent, field string) string {
	t.Helper()
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decode nested field: %v body=%s", err, body)
	}
	var nested map[string]any
	if err := json.Unmarshal(payload[parent], &nested); err != nil {
		t.Fatalf("decode %s: %v body=%s", parent, err, body)
	}
	value, _ := nested[field].(string)
	if value == "" {
		t.Fatalf("missing %s.%s in %s", parent, field, body)
	}
	return value
}

type assetPage struct {
	Assets     []assetLibraryResource `json:"assets"`
	NextCursor *string                `json:"next_cursor"`
}

func readAssetPage(t *testing.T, h *harness, token, path string) assetPage {
	t.Helper()
	status, body := h.doRequest(t, http.MethodGet, path, token, nil)
	if status != http.StatusOK {
		t.Fatalf("asset page %s: status=%d body=%s", path, status, body)
	}
	if bytes.Contains(body, []byte(`"id"`)) && !bytes.Contains(body, []byte(`"can_publish"`)) {
		t.Fatalf("asset page is missing publication capability: %s", body)
	}
	var page assetPage
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatalf("decode asset page: %v", err)
	}
	return page
}

type assetDownload struct {
	status       int
	body         []byte
	checksum     string
	contentRange string
}

func downloadAsset(t *testing.T, h *harness, token, id, byteRange string) assetDownload {
	t.Helper()
	req, err := http.NewRequestWithContext(h.ctx, http.MethodGet, h.serverURL+"/creation/assets/"+id+"/content", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if byteRange != "" {
		req.Header.Set("Range", byteRange)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return assetDownload{
		status: resp.StatusCode, body: body, checksum: resp.Header.Get("X-Content-SHA-256"),
		contentRange: resp.Header.Get("Content-Range"),
	}
}
