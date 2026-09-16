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
	} `json:"capabilities"`
}

func TestAssetLibraryTeamReadPrivacyDeleteAndDownload(t *testing.T) {
	h, adminToken, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creatorToken := h.loginToken(t, creatorEmailAddress, harnessPassword)
	otherToken := h.loginToken(t, otherCreatorEmail, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})
	createdSince := url.QueryEscape(time.Now().UTC().Format(time.RFC3339Nano))
	intent := h.imageTaskIntent(t, creatorToken, "Asset Library private prompt", 2)
	status, body := h.submitTask(t, creatorToken, "asset-library-flow", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	view := h.awaitTaskTerminal(t, creatorToken, decodeTaskView(t, body).Task.ID)
	if view.Task.Status != "succeeded" {
		t.Fatalf("task status=%s", view.Task.Status)
	}

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
		if len(page.Assets) != 1 || page.Assets[0].ID != first.ID {
			t.Fatalf("%s team page=%+v", name, page)
		}
		if page.Assets[0].Capabilities.CanCreateSimilar {
			t.Fatalf("%s received creator-only reuse capability", name)
		}
		if page.Assets[0].Capabilities.CanDelete != (name == "admin") {
			t.Fatalf("%s delete capability=%v", name, page.Assets[0].Capabilities.CanDelete)
		}
		status, detailBody := h.doRequest(t, http.MethodGet, "/creation/assets/"+first.ID, token, nil)
		if status != http.StatusOK || bytes.Contains(detailBody, []byte("private_origin")) || bytes.Contains(detailBody, []byte("private prompt")) {
			t.Fatalf("%s detail leaked private source: status=%d body=%s", name, status, detailBody)
		}
	}
	status, detailBody := h.doRequest(t, http.MethodGet, "/creation/assets/"+first.ID, creatorToken, nil)
	if status != http.StatusOK || !bytes.Contains(detailBody, []byte("private_origin")) || !bytes.Contains(detailBody, []byte("Asset Library private prompt")) {
		t.Fatalf("creator detail missed private origin: status=%d body=%s", status, detailBody)
	}

	whole := downloadAsset(t, h, otherToken, second.ID, "")
	digest := sha256.Sum256(whole.body)
	if whole.status != http.StatusOK || whole.checksum != hex.EncodeToString(digest[:]) {
		t.Fatalf("team download status=%d checksum=%q", whole.status, whole.checksum)
	}
	partial := downloadAsset(t, h, otherToken, second.ID, "bytes=0-15")
	if partial.status != http.StatusPartialContent || !bytes.Equal(partial.body, whole.body[:16]) || partial.contentRange != fmt.Sprintf("bytes 0-15/%d", len(whole.body)) {
		t.Fatalf("asset range status=%d range=%q len=%d", partial.status, partial.contentRange, len(partial.body))
	}

	if status, _ := h.doRequest(t, http.MethodDelete, "/creation/assets/"+first.ID, otherToken, nil); status != http.StatusNotFound {
		t.Fatalf("foreign member delete status=%d", status)
	}
	if status, _ := h.doRequest(t, http.MethodDelete, "/creation/assets/"+first.ID, adminToken, nil); status != http.StatusNoContent {
		t.Fatalf("admin delete status=%d", status)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/assets/"+first.ID+"/content", creatorToken, nil); status != http.StatusNotFound {
		t.Fatalf("deleted asset content status=%d", status)
	}

	if status, body := h.doRequest(t, http.MethodDelete, "/creation/sessions/"+intent.SessionID, creatorToken, nil); status != http.StatusNoContent {
		t.Fatalf("delete source session: status=%d body=%s", status, body)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/assets/"+second.ID, otherToken, nil); status != http.StatusOK {
		t.Fatalf("asset detail after source deletion status=%d", status)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE creation_media_assets SET restricted_at = now() WHERE id = $1::uuid`, second.ID); err != nil {
		t.Fatalf("restrict fixture asset: %v", err)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/assets/"+second.ID+"/content", adminToken, nil); status != http.StatusNotFound {
		t.Fatalf("restricted asset content status=%d", status)
	}
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
	if bytes.Contains(body, []byte(`"can_publish"`)) {
		t.Fatalf("asset page exposes publication capability before issue #164: %s", body)
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
