package integrationtest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
)

type restrictionMutationView struct {
	Asset       *restrictionResourceView `json:"asset"`
	Publication *restrictionResourceView `json:"publication"`
}

type restrictionResourceView struct {
	ID               string  `json:"id"`
	Restricted       bool    `json:"restricted"`
	RestrictionState *string `json:"restriction_state"`
	Capabilities     struct {
		CanRestrict      bool `json:"can_restrict"`
		CanRelease       bool `json:"can_release"`
		CanCreateSimilar bool `json:"can_create_similar"`
		CanPublish       bool `json:"can_publish"`
	} `json:"capabilities"`
}

func TestAdminSafetyRestrictionsAreAuditedTerminalAndNonRetroactive(t *testing.T) {
	h, adminToken, creatorEmailAddress := readyTaskHarness(t, harnessOptions{runWorkers: true})
	creatorToken := h.loginToken(t, creatorEmailAddress, harnessPassword)
	memberToken := h.loginToken(t, otherCreatorEmail, harnessPassword)
	h.kapon.generation.setImage(imageScript{outputs: 1})

	intent := h.imageTaskIntent(t, creatorToken, "safety prompt must never enter audit", 1)
	status, body := h.submitTask(t, creatorToken, "safety-restriction-task", intent)
	if status != http.StatusCreated {
		t.Fatalf("submit safety fixture: status=%d body=%s", status, body)
	}
	taskID := decodeTaskView(t, body).Task.ID
	if task := h.awaitTaskTerminal(t, creatorToken, taskID); task.Task.Status != "succeeded" {
		t.Fatalf("safety fixture task status=%s", task.Task.Status)
	}
	assetID := newestAssetID(t, h, creatorToken)

	status, body = h.doRequest(t, http.MethodPost, "/creation/assets/"+assetID+"/publication", creatorToken, map[string]any{"idempotency_key": "safety-publication-one"})
	if status != http.StatusCreated {
		t.Fatalf("publish safety fixture: status=%d body=%s", status, body)
	}
	publicationID := extractNestedField(t, body, "publication", "id")
	status, body = h.doRequest(t, http.MethodPost, "/creation/publications/"+publicationID+"/create-similar", memberToken, map[string]any{"idempotency_key": "safety-similar-before"})
	if status != http.StatusCreated {
		t.Fatalf("create prior similar: status=%d body=%s", status, body)
	}
	priorSimilarSessionID := extractNestedField(t, body, "session", "id")

	assertRestrictionGuardMatrix(t, h, creatorToken, memberToken, assetID, publicationID)
	installRejectedSafetyAudit(t, h, "media_asset_restricted")
	status, body = h.doRequest(t, http.MethodPut, "/creation/inspiration/assets/"+assetID+"/restriction", adminToken, nil)
	if status != http.StatusInternalServerError {
		t.Fatalf("audit failure restriction status=%d body=%s", status, body)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/assets/"+assetID, creatorToken, nil); status != http.StatusOK {
		t.Fatalf("audit failure did not roll asset restriction back: status=%d", status)
	}
	removeRejectedSafetyAudit(t, h)

	beforeRestrict := safetyAuditCount(t, h, "media_asset_restricted", assetID)
	activeAsset := mutateRestriction(t, h, http.MethodPut, "/creation/inspiration/assets/"+assetID+"/restriction", adminToken, "asset")
	assertRestrictionState(t, activeAsset, assetID, "active", true, false, true)
	activeReplay := mutateRestriction(t, h, http.MethodPut, "/creation/inspiration/assets/"+assetID+"/restriction", adminToken, "asset")
	assertRestrictionState(t, activeReplay, assetID, "active", true, false, true)
	if got := safetyAuditCount(t, h, "media_asset_restricted", assetID); got != beforeRestrict+1 {
		t.Fatalf("asset restriction audit count=%d want=%d", got, beforeRestrict+1)
	}

	for name, request := range map[string]struct {
		method string
		path   string
		body   any
	}{
		"creator asset detail":   {http.MethodGet, "/creation/assets/" + assetID, nil},
		"creator asset download": {http.MethodGet, "/creation/assets/" + assetID + "/content", nil},
		"creator publish":        {http.MethodPost, "/creation/assets/" + assetID + "/publication", map[string]any{"idempotency_key": "safety-publish-blocked"}},
		"member publication":     {http.MethodGet, "/creation/publications/" + publicationID, nil},
		"member download":        {http.MethodGet, "/creation/publications/" + publicationID + "/content", nil},
		"member new similar":     {http.MethodPost, "/creation/publications/" + publicationID + "/create-similar", map[string]any{"idempotency_key": "safety-similar-blocked"}},
	} {
		t.Run(name+" is blocked", func(t *testing.T) {
			token := creatorToken
			if bytes.HasPrefix([]byte(name), []byte("member")) {
				token = memberToken
			}
			if status, response := h.doRequest(t, request.method, request.path, token, request.body); status != http.StatusNotFound {
				t.Fatalf("status=%d body=%s", status, response)
			}
		})
	}
	if status, body := h.doRequest(t, http.MethodGet, "/creation/inspiration/assets/"+assetID, adminToken, nil); status != http.StatusOK || !bytes.Contains(body, []byte("safety prompt must never enter audit")) {
		t.Fatalf("admin exact restricted asset detail status=%d body=%s", status, body)
	}
	if download := downloadInspirationAsset(t, h, adminToken, assetID); download.status != http.StatusOK || len(download.body) == 0 {
		t.Fatalf("admin exact restricted asset download status=%d bytes=%d", download.status, len(download.body))
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/tasks/"+taskID, creatorToken, nil); status != http.StatusOK {
		t.Fatalf("admitted task was retroactively revoked: status=%d", status)
	}
	status, body = h.doRequest(t, http.MethodPost, "/creation/publications/"+publicationID+"/create-similar", memberToken, map[string]any{"idempotency_key": "safety-similar-before"})
	if status != http.StatusOK || extractNestedField(t, body, "session", "id") != priorSimilarSessionID {
		t.Fatalf("prior similar replay status=%d body=%s", status, body)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/sessions/"+priorSimilarSessionID, memberToken, nil); status != http.StatusOK {
		t.Fatalf("prior similar session was retroactively revoked: status=%d", status)
	}

	beforeRelease := safetyAuditCount(t, h, "media_asset_restriction_released", assetID)
	installRejectedSafetyAudit(t, h, "media_asset_restriction_released")
	status, body = h.doRequest(t, http.MethodDelete, "/creation/inspiration/assets/"+assetID+"/restriction", adminToken, nil)
	if status != http.StatusInternalServerError {
		t.Fatalf("asset release audit failure status=%d body=%s", status, body)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/assets/"+assetID, creatorToken, nil); status != http.StatusNotFound {
		t.Fatalf("asset release audit failure changed active state: status=%d", status)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/publications/"+publicationID, memberToken, nil); status != http.StatusNotFound {
		t.Fatalf("asset release audit failure restored publication: status=%d", status)
	}
	removeRejectedSafetyAudit(t, h)
	releasedAsset := mutateRestriction(t, h, http.MethodDelete, "/creation/inspiration/assets/"+assetID+"/restriction", adminToken, "asset")
	assertRestrictionState(t, releasedAsset, assetID, "released", false, true, false)
	releaseReplay := mutateRestriction(t, h, http.MethodDelete, "/creation/inspiration/assets/"+assetID+"/restriction", adminToken, "asset")
	assertRestrictionState(t, releaseReplay, assetID, "released", false, true, false)
	if got := safetyAuditCount(t, h, "media_asset_restriction_released", assetID); got != beforeRelease+1 {
		t.Fatalf("asset release audit count=%d want=%d", got, beforeRelease+1)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/publications/"+publicationID, memberToken, nil); status != http.StatusNotFound {
		t.Fatalf("asset release restored terminal publication: status=%d", status)
	}
	status, body = h.doRequest(t, http.MethodPost, "/creation/assets/"+assetID+"/publication", creatorToken, map[string]any{"idempotency_key": "safety-publication-two"})
	if status != http.StatusCreated {
		t.Fatalf("publish after asset release: status=%d body=%s", status, body)
	}
	secondPublicationID := extractNestedField(t, body, "publication", "id")
	if secondPublicationID == publicationID {
		t.Fatal("asset release restored the old publication identity")
	}

	beforePublicationRestrict := safetyAuditCount(t, h, "team_publication_restricted", secondPublicationID)
	installRejectedSafetyAudit(t, h, "team_publication_restricted")
	status, body = h.doRequest(t, http.MethodPut, "/creation/publications/"+secondPublicationID+"/restriction", adminToken, nil)
	if status != http.StatusInternalServerError {
		t.Fatalf("publication restriction audit failure status=%d body=%s", status, body)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/publications/"+secondPublicationID, memberToken, nil); status != http.StatusOK {
		t.Fatalf("publication restriction audit failure changed public state: status=%d", status)
	}
	removeRejectedSafetyAudit(t, h)
	activePublication := mutateRestriction(t, h, http.MethodPut, "/creation/publications/"+secondPublicationID+"/restriction", adminToken, "publication")
	assertRestrictionState(t, activePublication, secondPublicationID, "active", true, false, true)
	_ = mutateRestriction(t, h, http.MethodPut, "/creation/publications/"+secondPublicationID+"/restriction", adminToken, "publication")
	if got := safetyAuditCount(t, h, "team_publication_restricted", secondPublicationID); got != beforePublicationRestrict+1 {
		t.Fatalf("publication restriction audit count=%d want=%d", got, beforePublicationRestrict+1)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/publications/"+secondPublicationID, memberToken, nil); status != http.StatusNotFound {
		t.Fatalf("publication restriction bypass status=%d", status)
	}
	if page := readAssetPage(t, h, creatorToken, "/creation/assets?search="+assetID); len(page.Assets) != 1 || page.Assets[0].Capabilities.CanPublish {
		t.Fatalf("active publication restriction advertised publish capability: %+v", page)
	}
	if status, body := h.doRequest(t, http.MethodPost, "/creation/assets/"+assetID+"/publication", creatorToken, map[string]any{"idempotency_key": "safety-publish-direct-active"}); status != http.StatusNotFound {
		t.Fatalf("active publication restriction allowed fresh publish: status=%d body=%s", status, body)
	}
	_ = mutateRestriction(t, h, http.MethodPut, "/creation/inspiration/assets/"+assetID+"/restriction", adminToken, "asset")
	_ = mutateRestriction(t, h, http.MethodDelete, "/creation/inspiration/assets/"+assetID+"/restriction", adminToken, "asset")
	status, body = h.doRequest(t, http.MethodGet, "/creation/inspiration/assets/"+assetID, adminToken, nil)
	var directAfterAssetRelease adminPublicationStateView
	mustDecode(t, body, &directAfterAssetRelease)
	if status != http.StatusOK || directAfterAssetRelease.Publication == nil ||
		directAfterAssetRelease.Publication.RestrictionState == nil ||
		*directAfterAssetRelease.Publication.RestrictionState != "active" ||
		!directAfterAssetRelease.Publication.Capabilities.CanRelease {
		t.Fatalf("asset release masked direct publication restriction: status=%d detail=%+v body=%s", status, directAfterAssetRelease, body)
	}

	beforePublicationRelease := safetyAuditCount(t, h, "team_publication_restriction_released", secondPublicationID)
	installRejectedSafetyAudit(t, h, "team_publication_restriction_released")
	status, body = h.doRequest(t, http.MethodDelete, "/creation/publications/"+secondPublicationID+"/restriction", adminToken, nil)
	if status != http.StatusInternalServerError {
		t.Fatalf("publication release audit failure status=%d body=%s", status, body)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/publications/"+secondPublicationID, memberToken, nil); status != http.StatusNotFound {
		t.Fatalf("publication release audit failure restored terminal identity: status=%d", status)
	}
	if status, body := h.doRequest(t, http.MethodPost, "/creation/assets/"+assetID+"/publication", creatorToken, map[string]any{"idempotency_key": "safety-publish-release-rollback"}); status != http.StatusNotFound {
		t.Fatalf("publication release audit failure lifted publish block: status=%d body=%s", status, body)
	}
	removeRejectedSafetyAudit(t, h)
	releasedPublication := mutateRestriction(t, h, http.MethodDelete, "/creation/publications/"+secondPublicationID+"/restriction", adminToken, "publication")
	assertRestrictionState(t, releasedPublication, secondPublicationID, "released", false, true, false)
	_ = mutateRestriction(t, h, http.MethodDelete, "/creation/publications/"+secondPublicationID+"/restriction", adminToken, "publication")
	if got := safetyAuditCount(t, h, "team_publication_restriction_released", secondPublicationID); got != beforePublicationRelease+1 {
		t.Fatalf("publication release audit count=%d want=%d", got, beforePublicationRelease+1)
	}
	if status, _ := h.doRequest(t, http.MethodGet, "/creation/publications/"+secondPublicationID, memberToken, nil); status != http.StatusNotFound {
		t.Fatalf("publication release restored terminal identity: status=%d", status)
	}
	status, body = h.doRequest(t, http.MethodPost, "/creation/assets/"+assetID+"/publication", creatorToken, map[string]any{"idempotency_key": "safety-publication-three"})
	if status != http.StatusCreated || extractNestedField(t, body, "publication", "id") == secondPublicationID {
		t.Fatalf("fresh publication after release status=%d body=%s", status, body)
	}

	assertSafetyAuditRedacted(t, h, assetID, publicationID, secondPublicationID)
}

func newestAssetID(t *testing.T, h *harness, token string) string {
	t.Helper()
	page := readAssetPage(t, h, token, "/creation/assets?sort=newest&limit=1")
	if len(page.Assets) != 1 {
		t.Fatalf("newest asset page=%+v", page)
	}
	return page.Assets[0].ID
}

func assertRestrictionGuardMatrix(t *testing.T, h *harness, creatorToken, memberToken, assetID, publicationID string) {
	t.Helper()
	paths := []string{
		"/creation/inspiration/assets/" + assetID + "/restriction",
		"/creation/publications/" + publicationID + "/restriction",
	}
	for _, path := range paths {
		for _, method := range []string{http.MethodPut, http.MethodDelete} {
			if status, _ := h.doRequest(t, method, path, "", nil); status != http.StatusUnauthorized {
				t.Fatalf("anonymous %s %s status=%d", method, path, status)
			}
			for name, token := range map[string]string{"creator": creatorToken, "member": memberToken} {
				if status, _ := h.doRequest(t, method, path, token, nil); status != http.StatusForbidden {
					t.Fatalf("%s %s %s status=%d", name, method, path, status)
				}
			}
		}
	}
}

func mutateRestriction(t *testing.T, h *harness, method, path, token, envelope string) restrictionResourceView {
	t.Helper()
	status, body := h.doRequest(t, method, path, token, nil)
	if status != http.StatusOK {
		t.Fatalf("%s %s status=%d body=%s", method, path, status, body)
	}
	var response restrictionMutationView
	mustDecode(t, body, &response)
	resource := response.Asset
	if envelope == "publication" {
		resource = response.Publication
	}
	if resource == nil {
		t.Fatalf("missing %s envelope in %s", envelope, body)
	}
	return *resource
}

func assertRestrictionState(t *testing.T, resource restrictionResourceView, id, state string, restricted, canRestrict, canRelease bool) {
	t.Helper()
	if resource.ID != id || resource.Restricted != restricted || resource.RestrictionState == nil ||
		*resource.RestrictionState != state || resource.Capabilities.CanRestrict != canRestrict ||
		resource.Capabilities.CanRelease != canRelease || resource.Capabilities.CanCreateSimilar {
		t.Fatalf("restriction resource=%+v want id=%s state=%s restricted=%v restrict=%v release=%v", resource, id, state, restricted, canRestrict, canRelease)
	}
}

func installRejectedSafetyAudit(t *testing.T, h *harness, action string) {
	t.Helper()
	removeRejectedSafetyAudit(t, h)
	statement := fmt.Sprintf(`
		CREATE FUNCTION public.test_reject_safety_audit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'test rejected safety audit'; END;
		$$;
		CREATE TRIGGER test_reject_safety_audit BEFORE INSERT ON public.audit_logs
		FOR EACH ROW WHEN (NEW.action = '%s') EXECUTE FUNCTION public.test_reject_safety_audit()`, action)
	if _, err := h.ownerPool.Exec(h.ctx, statement); err != nil {
		t.Fatalf("install rejected safety audit: %v", err)
	}
	t.Cleanup(func() { removeRejectedSafetyAudit(t, h) })
}

func removeRejectedSafetyAudit(t *testing.T, h *harness) {
	t.Helper()
	if _, err := h.ownerPool.Exec(h.ctx, `
		DROP TRIGGER IF EXISTS test_reject_safety_audit ON public.audit_logs;
		DROP FUNCTION IF EXISTS public.test_reject_safety_audit()`); err != nil {
		t.Fatalf("remove rejected safety audit: %v", err)
	}
}

func safetyAuditCount(t *testing.T, h *harness, action, resourceID string) int {
	t.Helper()
	var count int
	if err := h.ownerPool.QueryRow(h.ctx, `
		SELECT count(*) FROM audit_logs
		WHERE action = $1 AND metadata->>'resource_id' = $2`, action, resourceID).Scan(&count); err != nil {
		t.Fatalf("count %s audit: %v", action, err)
	}
	return count
}

func assertSafetyAuditRedacted(t *testing.T, h *harness, ids ...string) {
	t.Helper()
	rows, err := h.ownerPool.Query(h.ctx, `
		SELECT action, metadata::text FROM audit_logs
		WHERE action IN ('media_asset_restricted', 'media_asset_restriction_released',
		                 'team_publication_restricted', 'team_publication_restriction_released')
		  AND metadata->>'resource_id' = ANY($1::text[])`, ids)
	if err != nil {
		t.Fatalf("read safety audits: %v", err)
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var action, metadata string
		if err := rows.Scan(&action, &metadata); err != nil {
			t.Fatal(err)
		}
		seen++
		var fields map[string]string
		if err := json.Unmarshal([]byte(metadata), &fields); err != nil {
			t.Fatalf("decode %s audit: %v", action, err)
		}
		if len(fields) != 3 || fields["resource_id"] == "" || fields["resource_kind"] == "" || fields["restriction_state"] == "" {
			t.Fatalf("unexpected %s audit fields=%v", action, fields)
		}
		for _, forbidden := range []string{"prompt", "url", "blob", "reference", "provider", "safety prompt"} {
			if bytes.Contains(bytes.ToLower([]byte(metadata)), []byte(forbidden)) {
				t.Fatalf("%s audit leaked %q: %s", action, forbidden, metadata)
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if seen < 4 {
		t.Fatalf("safety audit rows=%d want at least four", seen)
	}
}

func downloadInspirationAsset(t *testing.T, h *harness, token, id string) assetDownload {
	t.Helper()
	req, err := http.NewRequestWithContext(h.ctx, http.MethodGet, h.serverURL+"/creation/inspiration/assets/"+id+"/content", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read admin asset content: %v", err)
	}
	return assetDownload{status: resp.StatusCode, body: body}
}
