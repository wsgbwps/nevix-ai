package integrationtest

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// Capability Manifest flows (issue #158) through the Module's public HTTP
// seams: the source-controlled contract, instance Connection facts,
// per-media degradation, transient-check stability, and read authorization.

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
	Models    []struct {
		Model             string   `json:"model"`
		Resolutions       []string `json:"resolutions"`
		DefaultResolution string   `json:"default_resolution"`
		Sizes             []struct {
			Resolution string `json:"resolution"`
			Ratio      string `json:"ratio"`
			Width      int    `json:"width"`
			Height     int    `json:"height"`
		} `json:"sizes"`
	} `json:"models"`
	Modes []struct {
		ID string `json:"id"`
	} `json:"modes"`
	Ratios     []string `json:"ratios"`
	Quantities []int    `json:"quantities"`
	Durations  []int    `json:"durations"`
	Defaults   *struct {
		Ratio    string `json:"ratio"`
		Quantity int    `json:"quantity"`
		Duration int    `json:"duration"`
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

// A fresh deployment has no Provider Connection, so both media fail closed
// with the instance-owned action instead of requiring a separate release gate.
func TestCapabilityManifestWithoutConnectionIsUnavailable(t *testing.T) {
	h := newHarness(t)
	h.ensureAccounts(t)
	h.resetProviderConnections(t)
	token := h.loginToken(t, creatorEmail, harnessPassword)

	status, body, payload := h.getManifest(t, token)
	if status != http.StatusOK {
		t.Fatalf("manifest must answer 200, got %d: %s", status, body)
	}
	if payload.SchemaVersion != 2 || payload.ManifestVersion != 5 {
		t.Fatalf("manifest must publish its schema and content versions: %+v", payload)
	}
	for media, view := range map[string]manifestMedia{"image": payload.Image, "video": payload.Video} {
		if view.Available || view.Reason != "not_configured" || view.Action != "contact_admin" {
			t.Fatalf("%s must be not-configured, got %+v", media, view)
		}
		if view.Models != nil || view.Modes != nil || view.Defaults != nil {
			t.Fatalf("%s unavailable view must not publish values: %+v", media, view)
		}
	}
	assertContractResponse(t, "GET", "/creation/capability-manifest", status, body)
}

// A working connection publishes the complete source-controlled sets with
// in-set defaults — and admins and members see the identical payload.
func TestCapabilityManifestActivatesWithConnection(t *testing.T) {
	h := newHarness(t)
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

	// expectedModelSpec is one manifest models entry the flow test demands.
	// pixelSizes is the published size-entry count (tiers × ratios); 0 means
	// the model must publish no sizes at all (video).
	type expectedModelSpec struct {
		model             string
		resolutions       []string
		defaultResolution string
		pixelSizes        int
	}
	expectations := []struct {
		media  string
		view   manifestMedia
		models []expectedModelSpec
		modes  []string
	}{
		{"image", payload.Image, []expectedModelSpec{
			{"doubao-seedream-5.0-pro", []string{"1K", "1.5K", "2K"}, "2K", 24},
			{"doubao-seedream-5.0", []string{"2K", "3K", "4K"}, "2K", 24},
		}, []string{"text-to-image", "reference-image"}},
		{"video", payload.Video, []expectedModelSpec{
			{"doubao-seedance-2-5", []string{"480p", "720p", "1080p"}, "720p", 0},
		}, []string{"text-to-video", "first-frame", "first-last-frame", "omni-reference"}},
	}
	for _, want := range expectations {
		view := want.view
		if !view.Available || view.Reason != "" || view.Action != "" {
			t.Fatalf("%s must be available with a checked connection, got %+v", want.media, view)
		}
		if len(view.Models) != len(want.models) {
			t.Fatalf("%s models = %+v, want %d entries", want.media, view.Models, len(want.models))
		}
		for index, wantModel := range want.models {
			gotModel := view.Models[index]
			if gotModel.Model != wantModel.model {
				t.Fatalf("%s model[%d] = %q, want %q", want.media, index, gotModel.Model, wantModel.model)
			}
			if strings.Join(gotModel.Resolutions, ",") != strings.Join(wantModel.resolutions, ",") {
				t.Fatalf("%s %s resolutions = %v, want %v", want.media, gotModel.Model, gotModel.Resolutions, wantModel.resolutions)
			}
			if gotModel.DefaultResolution != wantModel.defaultResolution {
				t.Fatalf("%s %s default resolution = %q, want %q", want.media, gotModel.Model, gotModel.DefaultResolution, wantModel.defaultResolution)
			}
			if wantModel.pixelSizes == 0 {
				if gotModel.Sizes != nil {
					t.Fatalf("%s %s must publish no pixel sizes, got %d entries", want.media, gotModel.Model, len(gotModel.Sizes))
				}
				continue
			}
			if len(gotModel.Sizes) != wantModel.pixelSizes {
				t.Fatalf("%s %s sizes = %d entries, want %d", want.media, gotModel.Model, len(gotModel.Sizes), wantModel.pixelSizes)
			}
			if gotModel.Model != "doubao-seedream-5.0-pro" {
				continue
			}
			for _, size := range gotModel.Sizes {
				if size.Resolution == "1K" && size.Ratio == "9:16" && (size.Width != 800 || size.Height != 1424) {
					t.Fatalf("pro 9:16 1K must publish 800x1424, got %dx%d", size.Width, size.Height)
				}
			}
		}
		gotModes := make([]string, 0, len(view.Modes))
		for _, mode := range view.Modes {
			gotModes = append(gotModes, mode.ID)
		}
		if strings.Join(gotModes, ",") != strings.Join(want.modes, ",") {
			t.Fatalf("%s modes = %v, want %v", want.media, gotModes, want.modes)
		}
		if view.Defaults == nil || view.Prompt == nil || view.ReferenceMaterial == nil {
			t.Fatalf("%s must publish defaults, prompt and reference policy: %+v", want.media, view)
		}
		if view.Prompt.MinChars != 1 || view.Prompt.MaxChars != 2000 {
			t.Fatalf("%s prompt envelope must mirror the spec contract: %+v", want.media, view.Prompt)
		}
	}
	if strings.Join(payload.Image.Ratios, ",") != "1:1,4:3,3:4,16:9,9:16,3:2,2:3,21:9" {
		t.Fatalf("image ratios = %v", payload.Image.Ratios)
	}
	if joinInts(payload.Image.Quantities) != "1,2,3,4" {
		t.Fatalf("image quantities = %v", payload.Image.Quantities)
	}
	if payload.Image.Defaults.Quantity != 1 || payload.Image.Defaults.Ratio != "1:1" {
		t.Fatalf("image defaults = %+v", payload.Image.Defaults)
	}
	if joinInts(payload.Video.Durations) != "5,10" || payload.Video.Defaults.Duration != 5 {
		t.Fatalf("video durations/defaults = %+v", payload.Video)
	}
	assertContractResponse(t, "GET", "/creation/capability-manifest", adminStatus, adminBody)
	assertContractResponse(t, "GET", "/creation/capability-manifest", memberStatus, memberBody)
}

// TestCapabilityManifestIndependentMediaDegradation: one model disappearing
// degrades only its own media in the manifest after an admin recheck.
func TestCapabilityManifestIndependentMediaDegradation(t *testing.T) {
	h := newHarness(t)
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
	if payload.Video.Models != nil || payload.Video.Modes != nil {
		t.Fatalf("degraded video must not publish values: %+v", payload.Video)
	}
}

// TestCapabilityManifestTransientCheckNeverRewrites: timeouts/429/5xx are
// transient — the manifest projection and the instance facts both keep
// their previous verdicts.
func TestCapabilityManifestTransientCheckNeverRewrites(t *testing.T) {
	h := newHarness(t)
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
