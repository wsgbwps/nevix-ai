package integrationtest

import (
	"bytes"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Asset display authorization (issue #289, ADR-0016): one creator's own,
// visible Media Asset is displayable, and every other question about it answers
// the same generic not_found so a guessed id learns nothing.
func TestAssetDisplayURLsAuthorizeTheOwningCreatorOnly(t *testing.T) {
	h, adminToken, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creatorToken := h.loginToken(t, creatorEmailAddress, harnessPassword)
	otherToken := h.loginToken(t, otherCreatorEmail, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 3})
	createdSince := url.QueryEscape(time.Now().UTC().Format(time.RFC3339Nano))
	intent := h.imageTaskIntent(t, creatorToken, "Asset display authorization", 3)
	status, body := h.submitTask(t, creatorToken, "asset-display-url", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	if view := h.awaitTaskTerminal(t, creatorToken, decodeTaskView(t, body).Task.ID); view.Task.Status != "succeeded" {
		t.Fatalf("task status=%s", view.Task.Status)
	}
	page := readAssetPage(t, h, creatorToken, "/creation/assets?limit=3&media_type=image&sort=newest&created_since="+createdSince)
	if len(page.Assets) != 3 {
		t.Fatalf("formed Assets=%+v", page.Assets)
	}
	// Three independent Assets so one can be restricted and one deleted
	// without disturbing the happy path.
	displayable, restrictable, deletable := page.Assets[0].ID, page.Assets[1].ID, page.Assets[2].ID

	for _, purpose := range []string{"thumbnail-url", "preview-url"} {
		t.Run(purpose, func(t *testing.T) {
			path := "/creation/assets/" + displayable + "/" + purpose

			status, grantBody := h.doRequest(t, http.MethodGet, path, creatorToken, nil)
			if status != http.StatusOK {
				t.Fatalf("creator %s status=%d body=%s", purpose, status, grantBody)
			}
			var grant struct {
				URL       string `json:"url"`
				ExpiresAt string `json:"expires_at"`
			}
			mustDecode(t, grantBody, &grant)
			if grant.URL == "" {
				t.Fatalf("creator %s grant carries no url: %s", purpose, grantBody)
			}
			expiresAt, err := time.Parse(time.RFC3339, grant.ExpiresAt)
			if err != nil {
				t.Fatalf("creator %s expires_at=%q: %v", purpose, grant.ExpiresAt, err)
			}
			if remaining := time.Until(expiresAt); remaining > 11*time.Minute || remaining < 8*time.Minute {
				t.Fatalf("creator %s grant lives %s, want approximately 10 minutes", purpose, remaining)
			}
			// One exact object, and the fixed variant of that object.
			blobKey := assetBlobKey(t, h, displayable)
			if !strings.Contains(grant.URL, blobKey) {
				t.Fatalf("creator %s grant does not address the exact object: %s", purpose, grant.URL)
			}
			if strings.Count(grant.URL, blobKey) != 1 {
				t.Fatalf("creator %s grant can address neighbours: %s", purpose, grant.URL)
			}
			switch purpose {
			case "thumbnail-url":
				if !strings.Contains(grant.URL, "w_320") || !strings.Contains(grant.URL, "format%2Cwebp") {
					t.Fatalf("wall grant is not the fixed 320px WebP variant: %s", grant.URL)
				}
			case "preview-url":
				// The fake store encodes the kind rather than the resize chain,
				// so this pins the purpose routing only; the 2048px chain itself
				// is asserted against the real adapter in the OSS conformance suite.
				if !strings.Contains(grant.URL, "kind=image") {
					t.Fatalf("detail grant is not the image preview variant: %s", grant.URL)
				}
			}
			if unauthenticated, _ := h.doRequest(t, http.MethodGet, path, "", nil); unauthenticated != http.StatusUnauthorized {
				t.Fatalf("unauthenticated %s status=%d, want 401", purpose, unauthenticated)
			}
			for name, token := range map[string]string{"member": otherToken, "admin": adminToken} {
				if foreign, _ := h.doRequest(t, http.MethodGet, path, token, nil); foreign != http.StatusNotFound {
					t.Fatalf("%s %s status=%d, want 404", name, purpose, foreign)
				}
			}
			unknown := "/creation/assets/00000000-0000-0000-0000-000000000001/" + purpose
			if code, _ := h.doRequest(t, http.MethodGet, unknown, creatorToken, nil); code != http.StatusNotFound {
				t.Fatalf("unknown %s status=%d, want 404", purpose, code)
			}
		})
	}

	// Neither the list nor the detail payload may carry a signed URL: the
	// renderer asks for one only when a card reaches the wall's near-visible
	// range or a detail opens (issue #289).
	for name, path := range map[string]string{
		"list":   "/creation/assets?limit=3&media_type=image&sort=newest&created_since=" + createdSince,
		"detail": "/creation/assets/" + displayable,
	} {
		status, payload := h.doRequest(t, http.MethodGet, path, creatorToken, nil)
		if status != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", name, status, payload)
		}
		for _, leak := range []string{"thumb.example", "preview.example", "x-oss-process", "expires_at"} {
			if bytes.Contains(payload, []byte(leak)) {
				t.Fatalf("%s payload leaked %q: %s", name, leak, payload)
			}
		}
	}

	// An active restriction blocks the next authorization for both purposes
	// immediately, and releasing it restores them.
	assertRestrictionBlocksAssetDisplay(t, h, adminToken, creatorToken, restrictable, true)
	mutateRestriction(t, h, http.MethodDelete, "/creation/inspiration/assets/"+restrictable+"/restriction", adminToken, "asset")
	assertRestrictionBlocksAssetDisplay(t, h, adminToken, creatorToken, restrictable, false)

	// A logically deleted Asset stops issuing fresh grants.
	if status, body := h.doRequest(t, http.MethodDelete, "/creation/assets/"+deletable, creatorToken, nil); status != http.StatusNoContent {
		t.Fatalf("delete Asset status=%d body=%s", status, body)
	}
	for _, purpose := range []string{"thumbnail-url", "preview-url"} {
		if code, _ := h.doRequest(t, http.MethodGet, "/creation/assets/"+deletable+"/"+purpose, creatorToken, nil); code != http.StatusNotFound {
			t.Fatalf("deleted Asset %s status=%d, want 404", purpose, code)
		}
	}

	// Disabling the owner retires their live session, so the grant path never
	// becomes a second authentication policy.
	var creatorID string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT id::text FROM users WHERE email = $1`, creatorEmailAddress).Scan(&creatorID); err != nil {
		t.Fatalf("resolve creator id: %v", err)
	}
	if _, err := h.ownerPool.Exec(h.ctx, `UPDATE users SET status = 'disabled' WHERE id = $1::uuid`, creatorID); err != nil {
		t.Fatalf("disable creator: %v", err)
	}
	// One shared database: a fixture left disabled poisons every later test.
	t.Cleanup(func() {
		if _, err := h.ownerPool.Exec(h.ctx, `UPDATE users SET status = 'active' WHERE id = $1::uuid`, creatorID); err != nil {
			t.Fatalf("restore creator fixture: %v", err)
		}
	})
	for _, purpose := range []string{"thumbnail-url", "preview-url"} {
		if code, _ := h.doRequest(t, http.MethodGet, "/creation/assets/"+displayable+"/"+purpose, creatorToken, nil); code != http.StatusUnauthorized {
			t.Fatalf("disabled owner %s status=%d, want 401", purpose, code)
		}
	}
}

// A video Asset has no wall thumbnail but still previews its untouched
// original, so the two purposes are not the same capability.
func TestAssetDisplayURLsSplitThumbnailFromPreviewByMediaType(t *testing.T) {
	h, _, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creatorToken := h.loginToken(t, creatorEmailAddress, harnessPassword)
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 0})
	createdSince := url.QueryEscape(time.Now().UTC().Format(time.RFC3339Nano))
	session := h.createSession(t, creatorToken, sessionName("asset-display-video"))
	intent := h.buildTaskIntent(t, creatorToken, session.ID, taskIntent{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "text-to-video",
		Resolution: "720p", Duration: 5, Prompt: "资产显示授权视频",
	})
	status, body := h.submitTask(t, creatorToken, "asset-display-video", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	if view := h.awaitTaskTerminal(t, creatorToken, decodeTaskView(t, body).Task.ID); view.Task.Status != "succeeded" {
		t.Fatalf("task status=%s", view.Task.Status)
	}
	page := readAssetPage(t, h, creatorToken, "/creation/assets?limit=1&media_type=video&sort=newest&created_since="+createdSince)
	if len(page.Assets) != 1 {
		t.Fatalf("formed video Assets=%+v", page.Assets)
	}
	assetID := page.Assets[0].ID

	if code, _ := h.doRequest(t, http.MethodGet, "/creation/assets/"+assetID+"/thumbnail-url", creatorToken, nil); code != http.StatusNotFound {
		t.Fatalf("video thumbnail-url status=%d, want 404", code)
	}
	status, previewBody := h.doRequest(t, http.MethodGet, "/creation/assets/"+assetID+"/preview-url", creatorToken, nil)
	if status != http.StatusOK {
		t.Fatalf("video preview-url status=%d body=%s", status, previewBody)
	}
	var grant struct {
		URL string `json:"url"`
	}
	mustDecode(t, previewBody, &grant)
	// The original object, with no image transform asked for and no Range in
	// the signature, so Chromium can pick its own byte ranges.
	if !strings.Contains(grant.URL, "kind=video") || strings.Contains(grant.URL, "x-oss-process") {
		t.Fatalf("video preview grant is not the untouched original: %s", grant.URL)
	}
	if !strings.Contains(grant.URL, assetBlobKey(t, h, assetID)) {
		t.Fatalf("video preview grant does not address the exact object: %s", grant.URL)
	}
}

func assertRestrictionBlocksAssetDisplay(t *testing.T, h *harness, adminToken, creatorToken, assetID string, blocked bool) {
	t.Helper()
	if blocked {
		mutateRestriction(t, h, http.MethodPut, "/creation/inspiration/assets/"+assetID+"/restriction", adminToken, "asset")
	}
	want := http.StatusOK
	if blocked {
		want = http.StatusNotFound
	}
	for _, purpose := range []string{"thumbnail-url", "preview-url"} {
		status, body := h.doRequest(t, http.MethodGet, "/creation/assets/"+assetID+"/"+purpose, creatorToken, nil)
		if status != want {
			t.Fatalf("restriction blocked=%v %s status=%d body=%s, want %d", blocked, purpose, status, body, want)
		}
	}
}

// assetBlobKey reads the exact object one Asset was formed from. The API never
// exposes it, so only the database can prove a grant addresses that one object
// and not a neighbour.
func assetBlobKey(t *testing.T, h *harness, assetID string) string {
	t.Helper()
	var key string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT blob_key FROM creation_media_assets WHERE id = $1::uuid`, assetID).Scan(&key); err != nil {
		t.Fatalf("resolve Asset blob key: %v", err)
	}
	if key == "" {
		t.Fatal("Asset has no blob key")
	}
	return key
}
