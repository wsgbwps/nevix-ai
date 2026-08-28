package integrationtest

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation"
)

// Capability Manifest flows (issue #158) through the Module's public HTTP
// seams: the readiness gate, its orthogonality to the instance Connection
// facts, per-media activation, transient-check stability, and the read
// authorization matrix. The slot id fixtures below mirror the embedded
// checklist (server/internal/creation/domain/readiness-checklist.json); a
// rename on either side fails loudly — unknown ids refuse module startup,
// missing ids keep a media readiness-pending and fail the assertions.

var manifestImageSlots = []string{
	"image.mode.text-to-image", "image.mode.reference-image",
	"image.ratio.1-1", "image.ratio.4-3", "image.ratio.4-5", "image.ratio.16-9", "image.ratio.9-16",
	"image.resolution.1k", "image.resolution.2k", "image.resolution.4k",
	"image.quantity.1", "image.quantity.2", "image.quantity.3", "image.quantity.4",
	"image.transfer.temp-url", "image.probe.png",
}

var manifestVideoSlots = []string{
	"video.mode.text-to-video", "video.mode.first-frame", "video.mode.first-last-frame", "video.mode.omni-reference",
	"video.resolution.480p", "video.resolution.720p", "video.resolution.1080p",
	"video.duration.5s", "video.duration.10s",
	"video.async.query", "video.transfer.temp-url",
	"video.probe.mp4", "video.probe.audio-track", "video.reference.envelope",
}

// writeEvidenceFile records one scenario's readiness evidence document.
func writeEvidenceFile(t *testing.T, slotIDs ...string) string {
	t.Helper()
	doc := map[string]any{
		"schema_version": 1,
		"generated_at":   time.Now().UTC().Format(time.RFC3339),
	}
	entries := make([]map[string]any, 0, len(slotIDs))
	for _, slotID := range slotIDs {
		entries = append(entries, map[string]any{
			"slot_id":      slotID,
			"status":       "passed",
			"checked_at":   time.Now().UTC().Format(time.RFC3339),
			"evidence_ref": "harness/" + slotID,
		})
	}
	doc["entries"] = entries
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal evidence: %v", err)
	}
	path := filepath.Join(t.TempDir(), "production-readiness.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write evidence file: %v", err)
	}
	return path
}

// joinInts renders an int list for compact comparison.
func joinInts(values []int) string {
	parts := make([]string, 0, len(values))
	for _, v := range values {
		parts = append(parts, strconv.Itoa(v))
	}
	return strings.Join(parts, ",")
}

// manifestMedia decodes one media's manifest projection.
type manifestMedia struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason"`
	Action    string `json:"action"`
	Model     string `json:"model"`
	Modes     []struct {
		ID string `json:"id"`
	} `json:"modes"`
	Ratios      []string `json:"ratios"`
	Resolutions []string `json:"resolutions"`
	Quantities  []int    `json:"quantities"`
	Durations   []int    `json:"durations"`
	Defaults    *struct {
		Ratio      string `json:"ratio"`
		Resolution string `json:"resolution"`
		Quantity   int    `json:"quantity"`
		Duration   int    `json:"duration"`
	} `json:"defaults"`
	Prompt *struct {
		MinChars int `json:"min_chars"`
		MaxChars int `json:"max_chars"`
	} `json:"prompt"`
	ReferenceMaterial *struct {
		Total struct {
			Min int `json:"min"`
			Max int `json:"max"`
		} `json:"total"`
	} `json:"reference_material"`
}

type manifestPayload struct {
	SchemaVersion   int           `json:"schema_version"`
	ManifestVersion int           `json:"manifest_version"`
	Image           manifestMedia `json:"image"`
	Video           manifestMedia `json:"video"`
}

func (h *harness) getManifest(t *testing.T, token string) (int, []byte, manifestPayload) {
	t.Helper()
	status, body := h.doRequest(t, "GET", "/creation/capability-manifest", token, nil)
	var payload manifestPayload
	if status == http.StatusOK {
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("decode manifest: %v", err)
		}
	}
	return status, body, payload
}

// TestCapabilityManifestWithoutEvidenceIsReadinessPending: a fresh
// deployment publishes no submittable values for anyone, with the stable
// pending reason and await-release advice.
func TestCapabilityManifestWithoutEvidenceIsReadinessPending(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)

	status, body, payload := h.getManifest(t, token)
	if status != http.StatusOK {
		t.Fatalf("manifest must answer 200, got %d: %s", status, body)
	}
	if payload.SchemaVersion != 1 || payload.ManifestVersion != 1 {
		t.Fatalf("manifest must publish its schema and content versions: %+v", payload)
	}
	for media, view := range map[string]manifestMedia{"image": payload.Image, "video": payload.Video} {
		if view.Available || view.Reason != "production_readiness_pending" || view.Action != "await_release" {
			t.Fatalf("%s must be readiness-pending, got %+v", media, view)
		}
		if view.Model != "" || view.Modes != nil || view.Resolutions != nil || view.Defaults != nil {
			t.Fatalf("%s pending view must not publish values: %+v", media, view)
		}
	}
	assertContractResponse(t, "GET", "/creation/capability-manifest", status, body)
}

// TestCapabilityManifestActivatesWithEvidenceAndConnection: full evidence
// plus a working connection publishes the complete submittable sets with
// in-set defaults — and admins and members see the identical payload.
func TestCapabilityManifestActivatesWithEvidenceAndConnection(t *testing.T) {
	h := newHarnessWithOptions(t, harnessOptions{readinessPath: writeEvidenceFile(t, append(append([]string{}, manifestImageSlots...), manifestVideoSlots...)...)})
	h.ensureAccounts(t)
	h.resetProviderConnections(t)
	t.Cleanup(func() { h.resetProviderConnections(t) })
	h.kapon.acceptKey("kapon-manifest-key")
	adminToken := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	memberToken := h.loginToken(t, creatorEmail, harnessPassword)

	if status, body := h.configureConnection(t, adminToken, "kapon-manifest-key"); status != http.StatusCreated {
		t.Fatalf("configure connection: status=%d body=%s", status, body)
	}

	adminStatus, adminBody, payload := h.getManifest(t, adminToken)
	if adminStatus != http.StatusOK {
		t.Fatalf("admin manifest: status=%d body=%s", adminStatus, adminBody)
	}
	memberStatus, memberBody, _ := h.getManifest(t, memberToken)
	if memberStatus != http.StatusOK {
		t.Fatalf("member manifest: status=%d body=%s", memberStatus, memberBody)
	}
	if string(adminBody) != string(memberBody) {
		t.Fatal("admin and member must receive the identical manifest payload")
	}

	expectations := []struct {
		media       string
		view        manifestMedia
		model       string
		modes       []string
		resolutions []string
	}{
		{"image", payload.Image, "doubao-seedream-5.0-lite", []string{"text-to-image", "reference-image"}, []string{"1K", "2K", "4K"}},
		{"video", payload.Video, "doubao-seedance-2-5", []string{"text-to-video", "first-frame", "first-last-frame", "omni-reference"}, []string{"480p", "720p", "1080p"}},
	}
	for _, want := range expectations {
		view := want.view
		if !view.Available || view.Reason != "" || view.Action != "" {
			t.Fatalf("%s must be available with full evidence, got %+v", want.media, view)
		}
		if view.Model != want.model {
			t.Fatalf("%s model = %q, want %q", want.media, view.Model, want.model)
		}
		gotModes := make([]string, 0, len(view.Modes))
		for _, mode := range view.Modes {
			gotModes = append(gotModes, mode.ID)
		}
		if strings.Join(gotModes, ",") != strings.Join(want.modes, ",") {
			t.Fatalf("%s modes = %v, want %v", want.media, gotModes, want.modes)
		}
		if strings.Join(view.Resolutions, ",") != strings.Join(want.resolutions, ",") {
			t.Fatalf("%s resolutions = %v, want %v", want.media, view.Resolutions, want.resolutions)
		}
		if view.Defaults == nil || view.Prompt == nil || view.ReferenceMaterial == nil {
			t.Fatalf("%s must publish defaults, prompt and reference policy: %+v", want.media, view)
		}
		if view.Prompt.MinChars != 1 || view.Prompt.MaxChars != 2000 {
			t.Fatalf("%s prompt envelope must mirror the spec contract: %+v", want.media, view.Prompt)
		}
	}
	if strings.Join(payload.Image.Ratios, ",") != "1:1,4:3,4:5,16:9,9:16" {
		t.Fatalf("image ratios = %v", payload.Image.Ratios)
	}
	if joinInts(payload.Image.Quantities) != "1,2,3,4" {
		t.Fatalf("image quantities = %v", payload.Image.Quantities)
	}
	if payload.Image.Defaults.Quantity != 1 || payload.Image.Defaults.Ratio != "1:1" || payload.Image.Defaults.Resolution != "2K" {
		t.Fatalf("image defaults = %+v", payload.Image.Defaults)
	}
	if joinInts(payload.Video.Durations) != "5,10" || payload.Video.Defaults.Duration != 5 || payload.Video.Defaults.Resolution != "720p" {
		t.Fatalf("video durations/defaults = %+v", payload.Video)
	}
	assertContractResponse(t, "GET", "/creation/capability-manifest", adminStatus, adminBody)
	assertContractResponse(t, "GET", "/creation/capability-manifest", memberStatus, memberBody)
}

// TestCapabilityManifestIndependentMediaDegradation: one model disappearing
// degrades only its own media in the manifest after an admin recheck.
func TestCapabilityManifestIndependentMediaDegradation(t *testing.T) {
	h := newHarnessWithOptions(t, harnessOptions{readinessPath: writeEvidenceFile(t, append(append([]string{}, manifestImageSlots...), manifestVideoSlots...)...)})
	h.ensureAccounts(t)
	h.resetProviderConnections(t)
	t.Cleanup(func() { h.resetProviderConnections(t) })
	h.kapon.acceptKey("kapon-manifest-key")
	adminToken := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)

	if status, body := h.configureConnection(t, adminToken, "kapon-manifest-key"); status != http.StatusCreated {
		t.Fatalf("configure connection: status=%d body=%s", status, body)
	}

	// The video model vanishes from the catalog; a recheck records the new
	// fact and the manifest must stop publishing video while image holds.
	h.kapon.setModels(true, false)
	if status, body := h.doSecureRequest(t, "POST", "/creation/provider-connection/recheck", adminToken, nil); status != http.StatusOK {
		t.Fatalf("recheck: status=%d body=%s", status, body)
	}

	_, _, payload := h.getManifest(t, adminToken)
	if !payload.Image.Available {
		t.Fatalf("image must stay available, got %+v", payload.Image)
	}
	if payload.Video.Available || payload.Video.Reason != "model_unavailable" || payload.Video.Action != "contact_admin" {
		t.Fatalf("video must degrade to model_unavailable/contact_admin, got %+v", payload.Video)
	}
	if payload.Video.Model != "" || payload.Video.Modes != nil {
		t.Fatalf("degraded video must not publish values: %+v", payload.Video)
	}
}

// TestCapabilityManifestTransientCheckNeverRewrites: timeouts/429/5xx are
// transient — the manifest projection and the instance facts both keep
// their previous verdicts.
func TestCapabilityManifestTransientCheckNeverRewrites(t *testing.T) {
	h := newHarnessWithOptions(t, harnessOptions{readinessPath: writeEvidenceFile(t, append(append([]string{}, manifestImageSlots...), manifestVideoSlots...)...)})
	h.ensureAccounts(t)
	h.resetProviderConnections(t)
	t.Cleanup(func() { h.resetProviderConnections(t) })
	h.kapon.acceptKey("kapon-manifest-key")
	adminToken := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)

	if status, body := h.configureConnection(t, adminToken, "kapon-manifest-key"); status != http.StatusCreated {
		t.Fatalf("configure connection: status=%d body=%s", status, body)
	}
	beforeStatus, beforeBody, before := h.getManifest(t, adminToken)
	if beforeStatus != http.StatusOK {
		t.Fatalf("baseline manifest: %s", beforeBody)
	}

	h.kapon.forceStatus(http.StatusTooManyRequests)
	if status, body := h.doSecureRequest(t, "POST", "/creation/provider-connection/recheck", adminToken, nil); status != http.StatusOK {
		t.Fatalf("transient recheck must still answer 200 with preserved states: status=%d body=%s", status, body)
	}
	h.kapon.forceStatus(0)

	afterStatus, afterBody, after := h.getManifest(t, adminToken)
	if afterStatus != http.StatusOK || string(afterBody) != string(beforeBody) {
		t.Fatalf("transient check must not change the manifest:\nbefore=%s\nafter=%s", beforeBody, afterBody)
	}
	if !before.Image.Available || !after.Image.Available || !before.Video.Available || !after.Video.Available {
		t.Fatal("both media must remain available across a transient check")
	}
}

// TestCapabilityManifestReadinessDoesNotRewriteConnectionFacts: readiness
// pending blocks the manifest but the configured connection's own check
// facts — admin view and member capabilities — stay exactly as recorded.
func TestCapabilityManifestReadinessDoesNotRewriteConnectionFacts(t *testing.T) {
	h := newHarness(t) // no evidence file
	h.ensureAccounts(t)
	h.resetProviderConnections(t)
	t.Cleanup(func() { h.resetProviderConnections(t) })
	h.kapon.acceptKey("kapon-manifest-key")
	adminToken := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	memberToken := h.loginToken(t, creatorEmail, harnessPassword)

	if status, body := h.configureConnection(t, adminToken, "kapon-manifest-key"); status != http.StatusCreated {
		t.Fatalf("configure connection: status=%d body=%s", status, body)
	}

	status, body := h.doRequest(t, "GET", "/creation/provider-connection", adminToken, nil)
	if status != http.StatusOK {
		t.Fatalf("admin connection view: status=%d body=%s", status, body)
	}
	connection := decodeObject(t, body)
	if connection["image_capability"] != "available" || connection["video_capability"] != "available" {
		t.Fatalf("connection check facts must be untouched by readiness: %v", connection)
	}

	memberStatus, memberBody := h.doRequest(t, "GET", "/creation/media-capabilities", memberToken, nil)
	if memberStatus != http.StatusOK {
		t.Fatalf("member capabilities: status=%d body=%s", memberStatus, memberBody)
	}
	capabilities := decodeObject(t, memberBody)
	image, _ := capabilities["image"].(map[string]any)
	video, _ := capabilities["video"].(map[string]any)
	if image["status"] != "available" || video["status"] != "available" {
		t.Fatalf("member capability facts must be untouched by readiness: %v", capabilities)
	}

	_, _, payload := h.getManifest(t, memberToken)
	if payload.Image.Available || payload.Image.Reason != "production_readiness_pending" {
		t.Fatalf("manifest must stay readiness-pending: %+v", payload.Image)
	}
}

// decodeObject reads one JSON response body into a generic object.
func decodeObject(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decode response object: %v (%s)", err, body)
	}
	return decoded
}

// TestCapabilityManifestAuthorizationMatrix: the manifest is active-user
// wide — members and admins read it, unauthenticated callers get the stable
// 401 envelope.
func TestCapabilityManifestAuthorizationMatrix(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)

	status, body, _ := h.getManifest(t, "")
	if status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated manifest must be 401, got %d", status)
	}
	assertContractResponse(t, "GET", "/creation/capability-manifest", status, body)

	adminToken := h.loginToken(t, harnessAdminEmail, harnessAdminPassword)
	if adminStatus, _, _ := h.getManifest(t, adminToken); adminStatus != http.StatusOK {
		t.Fatalf("admin must read the manifest, got %d", adminStatus)
	}
}

// TestCapabilityManifestInvalidEvidenceRefusesStartup: a present-but-invalid
// evidence document fails module construction loudly instead of silently
// deactivating every media.
func TestCapabilityManifestInvalidEvidenceRefusesStartup(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)

	path := filepath.Join(t.TempDir(), "production-readiness.json")
	invalid := []byte(`{"schema_version": 1, "entries": [{"slot_id": "image.resolution.8k", "status": "passed"}]}`)
	if err := os.WriteFile(path, invalid, 0o600); err != nil {
		t.Fatalf("write invalid evidence: %v", err)
	}
	_, err := creation.NewModule(h.ctx, h.runtimePool, creation.Config{
		StorageDriver:      "filesystem",
		StorageRoot:        os.Getenv("STORAGE_FS_ROOT"),
		SecretsDir:         h.secretsDir,
		KaponBaseURL:       h.kapon.URL(),
		CORSAllowedOrigins: []string{"https://test.local"},
		ReadinessFile:      path,
	}, creation.Deps{
		SessionAuthenticator: h.identity.SessionAuthenticator(),
		ReauthVerifier:       h.identity.ReauthProofs(),
	})
	if err == nil {
		t.Fatal("module construction must fail on an evidence document citing an unknown slot")
	}
	if strings.Contains(err.Error(), "SessionAuthenticator") {
		t.Fatalf("the failure must come from evidence validation, not a wiring gap: %v", err)
	}
}
