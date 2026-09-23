package integrationtest

import (
	"bytes"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// The Inspiration wall's two business views (issue #290, ADR-0016): an Admin's
// governance view of one exact Media Asset, and an active User's view of one
// effective Team Publication. Each view re-checks its own visibility query
// before signing, so a fresh grant can never outrun a restriction, a
// withdrawal, or a deletion — and neither path reaches a neighbouring object.
func TestInspirationDisplayURLsFollowEachViewsOwnVisibility(t *testing.T) {
	h, adminToken, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creatorToken := h.loginToken(t, creatorEmailAddress, harnessPassword)
	memberToken := h.loginToken(t, otherCreatorEmail, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 2})
	createdSince := url.QueryEscape(time.Now().UTC().Format(time.RFC3339Nano))
	status, body := h.submitTask(t, creatorToken, "inspiration-display", h.imageTaskIntent(t, creatorToken, "Inspiration display authorization", 2))
	if status != http.StatusCreated {
		t.Fatalf("submit: %d %s", status, body)
	}
	if view := h.awaitTaskTerminal(t, creatorToken, decodeTaskView(t, body).Task.ID); view.Task.Status != "succeeded" {
		t.Fatalf("task status=%s", view.Task.Status)
	}
	page := readAssetPage(t, h, creatorToken, "/creation/assets?limit=2&media_type=image&sort=newest&created_since="+createdSince)
	if len(page.Assets) != 2 {
		t.Fatalf("formed Assets=%+v", page.Assets)
	}
	// One Asset carries the Publication through every visibility state; the
	// other loses its source Asset while remaining published.
	governedAsset, orphanedSource := page.Assets[0].ID, page.Assets[1].ID
	publicationID := publishAsset(t, h, creatorToken, governedAsset, "inspiration-display-publication")

	// An active User sees the effective Publication under both variants.
	grant := assertDisplayGrant(t, h, "/creation/publications/"+publicationID+"/thumbnail-url", memberToken, publicationBlobKey(t, h, publicationID), "w_320")
	if !strings.Contains(grant, "format%2Cwebp") {
		t.Fatalf("wall grant is not the WebP variant: %s", grant)
	}
	assertDisplayGrant(t, h, "/creation/publications/"+publicationID+"/preview-url", memberToken, publicationBlobKey(t, h, publicationID), "kind=image")

	// The Admin governance view of the same Asset is a separate path, and its
	// wall and detail variants are the fixed pair.
	adminAssetThumbnail := assertDisplayGrant(t, h, "/creation/inspiration/assets/"+governedAsset+"/thumbnail-url", adminToken, assetBlobKey(t, h, governedAsset), "w_320")
	if !strings.Contains(adminAssetThumbnail, "format%2Cwebp") {
		t.Fatalf("admin wall grant is not the WebP variant: %s", adminAssetThumbnail)
	}
	assertDisplayGrant(t, h, "/creation/inspiration/assets/"+governedAsset+"/preview-url", adminToken, assetBlobKey(t, h, governedAsset), "kind=image")

	// Neither list nor detail payload may embed a signed URL: the renderer asks
	// for one only when a card becomes near-visible or a detail opens.
	for name, request := range map[string]struct{ path, token string }{
		"member inspiration": {"/creation/inspiration?limit=24&search=" + publicationID, memberToken},
		"admin inspiration":  {"/creation/inspiration?limit=24&search=" + publicationID, adminToken},
		"admin asset detail": {"/creation/inspiration/assets/" + governedAsset, adminToken},
		"publication detail": {"/creation/publications/" + publicationID, memberToken},
		"creator asset list": {"/creation/assets?limit=2&media_type=image&sort=newest&created_since=" + createdSince, creatorToken},
	} {
		status, payload := h.doRequest(t, http.MethodGet, request.path, request.token, nil)
		if status != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", name, status, payload)
		}
		for _, leak := range []string{"thumb.example", "preview.example", "x-oss-process", "expires_at"} {
			if bytes.Contains(payload, []byte(leak)) {
				t.Fatalf("%s payload leaked %q: %s", name, leak, payload)
			}
		}
	}

	// The Admin governance path is Admin-only, and every unknown or absent
	// identity collapses into that path's own not_found.
	for name, token := range map[string]string{"creator": creatorToken, "member": memberToken} {
		if status, _ := h.doRequest(t, http.MethodGet, "/creation/inspiration/assets/"+governedAsset+"/thumbnail-url", token, nil); status != http.StatusForbidden {
			t.Fatalf("%s admin asset thumbnail status=%d, want 403", name, status)
		}
	}
	for _, path := range []string{
		"/creation/inspiration/assets/" + governedAsset + "/thumbnail-url",
		"/creation/inspiration/assets/" + governedAsset + "/preview-url",
		"/creation/publications/" + publicationID + "/thumbnail-url",
		"/creation/publications/" + publicationID + "/preview-url",
	} {
		if status, _ := h.doRequest(t, http.MethodGet, path, "", nil); status != http.StatusUnauthorized {
			t.Fatalf("unauthenticated %s status=%d, want 401", path, status)
		}
		if status, _ := h.doRequest(t, http.MethodGet, path, "not-a-session", nil); status != http.StatusUnauthorized {
			t.Fatalf("invalid session %s status=%d, want 401", path, status)
		}
	}
	// Each identity's id is meaningless on the other's path: a grant never
	// crosses from a Publication to the Asset it snapshots, or the reverse.
	for name, path := range map[string]string{
		"publication id on the asset path": "/creation/inspiration/assets/" + publicationID + "/thumbnail-url",
		"asset id on the publication path": "/creation/publications/" + governedAsset + "/thumbnail-url",
		"unknown publication":              "/creation/publications/00000000-0000-0000-0000-000000000001/preview-url",
		"unknown asset":                    "/creation/inspiration/assets/00000000-0000-0000-0000-000000000001/preview-url",
	} {
		token := adminToken
		if strings.Contains(path, "/publications/") {
			token = memberToken
		}
		if status, response := h.doRequest(t, http.MethodGet, path, token, nil); status != http.StatusNotFound {
			t.Fatalf("%s status=%d body=%s, want 404", name, status, response)
		}
	}

	// An active restriction on the Asset stops the Publication's next grant
	// immediately, while the Admin governance view of that same Asset keeps
	// working — judging a restriction requires seeing what was restricted.
	// The cascade terminates the Publication, so releasing the Asset does not
	// bring it back (#165); a fresh Publication is a new identity.
	mutateRestriction(t, h, http.MethodPut, "/creation/inspiration/assets/"+governedAsset+"/restriction", adminToken, "asset")
	assertDisplayStatus(t, h, "/creation/publications/"+publicationID+"/thumbnail-url", memberToken, http.StatusNotFound)
	assertDisplayStatus(t, h, "/creation/publications/"+publicationID+"/preview-url", memberToken, http.StatusNotFound)
	assertDisplayGrant(t, h, "/creation/inspiration/assets/"+governedAsset+"/thumbnail-url", adminToken, assetBlobKey(t, h, governedAsset), "w_320")
	assertDisplayGrant(t, h, "/creation/inspiration/assets/"+governedAsset+"/preview-url", adminToken, assetBlobKey(t, h, governedAsset), "kind=image")
	mutateRestriction(t, h, http.MethodDelete, "/creation/inspiration/assets/"+governedAsset+"/restriction", adminToken, "asset")
	assertDisplayStatus(t, h, "/creation/publications/"+publicationID+"/thumbnail-url", memberToken, http.StatusNotFound)
	assertDisplayGrant(t, h, "/creation/inspiration/assets/"+governedAsset+"/thumbnail-url", adminToken, assetBlobKey(t, h, governedAsset), "w_320")
	republished := publishAsset(t, h, creatorToken, governedAsset, "inspiration-display-republished")
	if republished == publicationID {
		t.Fatal("a released Asset restriction restored the terminated Publication identity")
	}
	assertDisplayGrant(t, h, "/creation/publications/"+republished+"/thumbnail-url", memberToken, publicationBlobKey(t, h, republished), "w_320")

	// A directly restricted Publication is invisible to the active User and
	// still reachable by the Admin, exactly as its content route already is.
	mutateRestriction(t, h, http.MethodPut, "/creation/publications/"+republished+"/restriction", adminToken, "publication")
	assertDisplayStatus(t, h, "/creation/publications/"+republished+"/thumbnail-url", memberToken, http.StatusNotFound)
	assertDisplayGrant(t, h, "/creation/publications/"+republished+"/thumbnail-url", adminToken, publicationBlobKey(t, h, republished), "w_320")
	mutateRestriction(t, h, http.MethodDelete, "/creation/publications/"+republished+"/restriction", adminToken, "publication")
	for _, token := range []string{memberToken, adminToken} {
		assertDisplayStatus(t, h, "/creation/publications/"+republished+"/thumbnail-url", token, http.StatusNotFound)
	}

	// Withdrawal ends both ordinary views at once.
	withdrawn := publishAsset(t, h, creatorToken, governedAsset, "inspiration-display-withdrawn")
	assertDisplayGrant(t, h, "/creation/publications/"+withdrawn+"/thumbnail-url", memberToken, publicationBlobKey(t, h, withdrawn), "w_320")
	if status, response := h.doRequest(t, http.MethodDelete, "/creation/publications/"+withdrawn, creatorToken, nil); status != http.StatusNoContent {
		t.Fatalf("withdraw status=%d body=%s", status, response)
	}
	for _, token := range []string{memberToken, adminToken} {
		assertDisplayStatus(t, h, "/creation/publications/"+withdrawn+"/thumbnail-url", token, http.StatusNotFound)
		assertDisplayStatus(t, h, "/creation/publications/"+withdrawn+"/preview-url", token, http.StatusNotFound)
	}

	// An effective Publication outlives its source Asset's logical deletion
	// (the existing independent Publication lifetime), while the Admin view of
	// that deleted Asset is gone.
	orphanPublication := publishAsset(t, h, creatorToken, orphanedSource, "inspiration-display-orphan")
	if status, response := h.doRequest(t, http.MethodDelete, "/creation/assets/"+orphanedSource, creatorToken, nil); status != http.StatusNoContent {
		t.Fatalf("delete published source status=%d body=%s", status, response)
	}
	assertDisplayGrant(t, h, "/creation/publications/"+orphanPublication+"/thumbnail-url", memberToken, publicationBlobKey(t, h, orphanPublication), "w_320")
	assertDisplayGrant(t, h, "/creation/publications/"+orphanPublication+"/preview-url", memberToken, publicationBlobKey(t, h, orphanPublication), "kind=image")
	assertDisplayStatus(t, h, "/creation/inspiration/assets/"+orphanedSource+"/thumbnail-url", adminToken, http.StatusNotFound)
	assertDisplayStatus(t, h, "/creation/inspiration/assets/"+orphanedSource+"/preview-url", adminToken, http.StatusNotFound)
}

// A video Publication has no wall variant and previews its untouched original,
// so the two display purposes are not the same capability (#291 builds on this).
func TestInspirationDisplayURLsSplitThumbnailFromPreviewByMediaType(t *testing.T) {
	h, adminToken, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creatorToken := h.loginToken(t, creatorEmailAddress, harnessPassword)
	memberToken := h.loginToken(t, otherCreatorEmail, harnessPassword)
	h.kapon.generation.setVideo(videoTaskScript{succeedAfter: 0})
	createdSince := url.QueryEscape(time.Now().UTC().Format(time.RFC3339Nano))
	session := h.createSession(t, creatorToken, sessionName("inspiration-display-video"))
	intent := h.buildTaskIntent(t, creatorToken, session.ID, taskIntent{
		MediaType: "video", Model: "doubao-seedance-2-5", Mode: "text-to-video",
		Resolution: "720p", Duration: 5, Prompt: "灵感显示授权视频",
	})
	status, body := h.submitTask(t, creatorToken, "inspiration-display-video", intent)
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
	publicationID := publishAsset(t, h, creatorToken, assetID, "inspiration-display-video-publication")

	// Each path is checked against its own record's key: the Publication carries
	// the snapshot it published, the Admin path the Asset itself.
	for name, media := range map[string]struct{ path, token, blobKey string }{
		"publication": {"/creation/publications/" + publicationID, memberToken, publicationBlobKey(t, h, publicationID)},
		"admin asset": {"/creation/inspiration/assets/" + assetID, adminToken, assetBlobKey(t, h, assetID)},
	} {
		if status, _ := h.doRequest(t, http.MethodGet, media.path+"/thumbnail-url", media.token, nil); status != http.StatusNotFound {
			t.Fatalf("%s video thumbnail-url status=%d, want 404", name, status)
		}
		preview := assertDisplayGrant(t, h, media.path+"/preview-url", media.token, media.blobKey, "kind=video")
		// The original object, with no image transform in the signature, so
		// Chromium picks its own byte ranges.
		if strings.Contains(preview, "x-oss-process") {
			t.Fatalf("%s video preview grant carries an image transform: %s", name, preview)
		}
	}
}

func publishAsset(t *testing.T, h *harness, creatorToken, assetID, key string) string {
	t.Helper()
	status, body := h.doRequest(t, http.MethodPost, "/creation/assets/"+assetID+"/publication", creatorToken, map[string]any{"idempotency_key": key})
	if status != http.StatusCreated {
		t.Fatalf("publish %s status=%d body=%s", assetID, status, body)
	}
	return extractNestedField(t, body, "publication", "id")
}

// assertDisplayGrant asserts one authorized display variant and returns its URL:
// exactly one object, the fixed transform of the requested purpose, and the
// shared ten-minute lifetime.
func assertDisplayGrant(t *testing.T, h *harness, path, token, blobKey, variant string) string {
	t.Helper()
	status, body := h.doRequest(t, http.MethodGet, path, token, nil)
	if status != http.StatusOK {
		t.Fatalf("%s status=%d body=%s", path, status, body)
	}
	var grant struct {
		URL       string `json:"url"`
		ExpiresAt string `json:"expires_at"`
	}
	mustDecode(t, body, &grant)
	if grant.URL == "" {
		t.Fatalf("%s carries no url: %s", path, body)
	}
	if !strings.Contains(grant.URL, blobKey) {
		t.Fatalf("%s does not address the exact object: %s", path, grant.URL)
	}
	if strings.Count(grant.URL, blobKey) != 1 {
		t.Fatalf("%s can address neighbours: %s", path, grant.URL)
	}
	if !strings.Contains(grant.URL, variant) {
		t.Fatalf("%s is not the %q variant: %s", path, variant, grant.URL)
	}
	expiresAt, err := time.Parse(time.RFC3339, grant.ExpiresAt)
	if err != nil {
		t.Fatalf("%s expires_at=%q: %v", path, grant.ExpiresAt, err)
	}
	if remaining := time.Until(expiresAt); remaining > 11*time.Minute || remaining < 8*time.Minute {
		t.Fatalf("%s grant lives %s, want approximately 10 minutes", path, remaining)
	}
	return grant.URL
}

func assertDisplayStatus(t *testing.T, h *harness, path, token string, want int) {
	t.Helper()
	if status, body := h.doRequest(t, http.MethodGet, path, token, nil); status != want {
		t.Fatalf("%s status=%d body=%s, want %d", path, status, body, want)
	}
}

// publicationBlobKey reads the object a Publication snapshotted at publish
// time. Only the database can prove a grant addresses that one object.
func publicationBlobKey(t *testing.T, h *harness, publicationID string) string {
	t.Helper()
	var key string
	if err := h.ownerPool.QueryRow(h.ctx, `SELECT blob_key FROM creation_team_publications WHERE id = $1::uuid`, publicationID).Scan(&key); err != nil {
		t.Fatalf("resolve Publication blob key: %v", err)
	}
	if key == "" {
		t.Fatal("Publication has no blob key")
	}
	return key
}
