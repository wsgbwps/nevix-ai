package domain

import (
	"reflect"
	"testing"
)

func containsInt(values []int, want int) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}

func containsString(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}

func imageModeIDs(modes []CapabilityModeView) []string {
	ids := make([]string, 0, len(modes))
	for _, mode := range modes {
		ids = append(ids, mode.ID)
	}
	return ids
}

func connectionStates() []*ProviderConnection {
	var states []*ProviderConnection
	adminStates := []AdminState{AdminStateEnabled, AdminStatePaused}
	credentialStates := []CredentialState{CredentialStateChecking, CredentialStateValid, CredentialStateInvalid, CredentialStateCredentialUnavailable}
	capabilities := []MediaCapability{MediaCapabilityChecking, MediaCapabilityAvailable, MediaCapabilityUnavailable}
	for _, admin := range adminStates {
		for _, credential := range credentialStates {
			for _, image := range capabilities {
				for _, video := range capabilities {
					states = append(states, &ProviderConnection{
						ID:              NewUUID(),
						AdminState:      admin,
						CredentialState: credential,
						ImageCapability: image,
						VideoCapability: video,
					})
				}
			}
		}
	}
	return states
}

func assertUnavailableShape(t *testing.T, media string, view CapabilityMediaView) {
	t.Helper()
	if view.Available {
		t.Fatalf("%s: expected unavailable view", media)
	}
	if view.Reason == "" || view.Action == "" {
		t.Fatalf("%s: unavailable view must carry reason and action, got %q/%q", media, view.Reason, view.Action)
	}
	if view.Models != nil || view.Modes != nil || view.Ratios != nil ||
		view.Quantities != nil || view.Durations != nil || view.Defaults != nil ||
		view.Prompt != nil || view.ReferenceMaterial != nil {
		t.Fatalf("%s: unavailable view must not publish capability values", media)
	}
}

func assertAvailableShape(t *testing.T, media string, view CapabilityMediaView) {
	t.Helper()
	if !view.Available {
		t.Fatalf("%s: expected available view, got reason=%q", media, view.Reason)
	}
	if view.Reason != "" || view.Action != "" {
		t.Fatalf("%s: available view must not carry reason/action", media)
	}
	if len(view.Models) == 0 || len(view.Modes) == 0 || view.Defaults == nil || view.Prompt == nil || view.ReferenceMaterial == nil {
		t.Fatalf("%s: available view must publish models, modes, defaults, prompt and reference policy", media)
	}
	for _, model := range view.Models {
		if model.Model == "" || len(model.Resolutions) == 0 || !containsString(model.Resolutions, model.DefaultResolution) {
			t.Fatalf("%s: model must carry resolution tiers and an in-set default: %+v", media, model)
		}
		if media == string(MediaImage) {
			if len(model.Sizes) != len(model.Resolutions)*len(imageRatios) {
				t.Fatalf("%s: image model must publish a pixel size for every (tier, ratio): %+v", media, model)
			}
			for _, size := range model.Sizes {
				if !containsString(model.Resolutions, size.Resolution) || !containsString(imageRatios, size.Ratio) ||
					size.Width < 1 || size.Height < 1 {
					t.Fatalf("%s: pixel size outside the published cross product: %+v", media, size)
				}
			}
		} else if model.Sizes != nil {
			t.Fatalf("%s: video models publish no pixel sizes: %+v", media, model)
		}
	}
	if view.Prompt.MinChars != PromptMinChars || view.Prompt.MaxChars != PromptMaxChars {
		t.Fatalf("%s: prompt envelope must mirror the spec contract", media)
	}
}

func availableConnection() *ProviderConnection {
	return &ProviderConnection{
		ID:              NewUUID(),
		AdminState:      AdminStateEnabled,
		CredentialState: CredentialStateValid,
		ImageCapability: MediaCapabilityAvailable,
		VideoCapability: MediaCapabilityAvailable,
	}
}

// The manifest publishes the complete source-controlled contract whenever the
// instance Connection Check makes a media available.
func TestDeriveCapabilityManifestPublishesStaticContract(t *testing.T) {
	manifest := DeriveCapabilityManifest(availableConnection())
	if manifest.SchemaVersion != ManifestSchemaVersion || manifest.ManifestVersion != ManifestVersion {
		t.Fatalf("manifest must publish its schema and content versions: %+v", manifest)
	}

	assertAvailableShape(t, string(MediaImage), manifest.Image)
	if !reflect.DeepEqual(imageModeIDs(manifest.Image.Modes), imageModes) ||
		!reflect.DeepEqual(manifest.Image.Ratios, imageRatios) ||
		!reflect.DeepEqual(manifest.Image.Quantities, imageQuantities) ||
		!reflect.DeepEqual(manifest.Image.Models, expectedPublishedModels(string(MediaImage))) {
		t.Fatalf("image manifest drifted from its source-controlled contract: %+v", manifest.Image)
	}
	if manifest.Image.Defaults.Ratio != defaultImageRatio || manifest.Image.Defaults.Quantity != defaultImageQuantity {
		t.Fatalf("image defaults drifted: %+v", manifest.Image.Defaults)
	}
	// The published display sizes come from the same vendor table the adapter
	// submits: the field-reported combination must appear verbatim.
	if size := findPublishedSize(manifest.Image.Models, ImageModelID, "9:16", "1K"); size == nil ||
		size.Width != 800 || size.Height != 1424 {
		t.Fatalf("pro 9:16 1K must publish 800x1424, got %+v", size)
	}

	assertAvailableShape(t, string(MediaVideo), manifest.Video)
	if !reflect.DeepEqual(imageModeIDs(manifest.Video.Modes), videoModes) ||
		!reflect.DeepEqual(manifest.Video.Durations, videoDurations) ||
		!reflect.DeepEqual(manifest.Video.Models, videoModels) {
		t.Fatalf("video manifest drifted from its source-controlled contract: %+v", manifest.Video)
	}
	if manifest.Video.Defaults.Duration != defaultVideoDuration {
		t.Fatalf("video default drifted: %+v", manifest.Video.Defaults)
	}

	// Returned slices must not let a caller mutate the next projection.
	manifest.Image.Models[0].Resolutions[0] = "mutated"
	manifest.Image.Models[0].Sizes[0].Width = -1
	manifest.Image.Ratios[0] = "mutated"
	fresh := DeriveCapabilityManifest(availableConnection())
	if fresh.Image.Models[0].Resolutions[0] == "mutated" || fresh.Image.Ratios[0] == "mutated" ||
		fresh.Image.Models[0].Sizes[0].Width == -1 {
		t.Fatal("a returned manifest must not alias the source-controlled contract")
	}
}

// expectedPublishedModels projects the source-controlled models exactly as
// derivation publishes them — image models carrying their pixel sizes.
func expectedPublishedModels(media string) []CapabilityModelView {
	source := imageModels
	if media == string(MediaVideo) {
		source = videoModels
	}
	expected := make([]CapabilityModelView, 0, len(source))
	for _, model := range source {
		published := CapabilityModelView{
			Model:              model.Model,
			Resolutions:        append([]string(nil), model.Resolutions...),
			DefaultResolution:  model.DefaultResolution,
			MaxReferenceImages: model.MaxReferenceImages,
			Sizes:              modelSizes(media, model),
		}
		expected = append(expected, published)
	}
	return expected
}

func findPublishedSize(models []CapabilityModelView, model, ratio, resolution string) *CapabilitySizeView {
	for _, entry := range models {
		if entry.Model != model {
			continue
		}
		for i, size := range entry.Sizes {
			if size.Ratio == ratio && size.Resolution == resolution {
				return &entry.Sizes[i]
			}
		}
	}
	return nil
}

// Across all instance states, the manifest verdict is exactly the Connection
// Check projection; there is no second runtime gate.
func TestDeriveCapabilityManifestMirrorsConnectionFacts(t *testing.T) {
	for _, connection := range connectionStates() {
		manifest := DeriveCapabilityManifest(connection)
		instance := DeriveMediaCapabilities(connection)
		for media, pair := range map[string]struct {
			manifest CapabilityMediaView
			instance MediaCapabilityView
		}{
			string(MediaImage): {manifest: manifest.Image, instance: instance.Image},
			string(MediaVideo): {manifest: manifest.Video, instance: instance.Video},
		} {
			if pair.instance.Status == MediaCapabilityAvailable {
				assertAvailableShape(t, media, pair.manifest)
				continue
			}
			assertUnavailableShape(t, media, pair.manifest)
			if pair.manifest.Reason != pair.instance.Reason || pair.manifest.Action != pair.instance.Action {
				t.Fatalf("%s: manifest must mirror %q/%q, got %q/%q", media, pair.instance.Reason, pair.instance.Action, pair.manifest.Reason, pair.manifest.Action)
			}
		}
	}
}

func TestDeriveCapabilityManifestKeepsMediaIndependent(t *testing.T) {
	connection := availableConnection()
	connection.ImageCapability = MediaCapabilityUnavailable
	manifest := DeriveCapabilityManifest(connection)
	assertUnavailableShape(t, string(MediaImage), manifest.Image)
	assertAvailableShape(t, string(MediaVideo), manifest.Video)
}

func TestDeriveCapabilityManifestIsPureAndDeterministic(t *testing.T) {
	connection := availableConnection()
	connection.VideoCapability = MediaCapabilityUnavailable
	connection.Envelope = ptr(ProviderCredentialEnvelope{Version: 1, KeyID: "k", Nonce: []byte{1}, Ciphertext: []byte{2}})
	before := *connection
	first := DeriveCapabilityManifest(connection)
	second := DeriveCapabilityManifest(connection)
	if !reflect.DeepEqual(first, second) {
		t.Fatal("derivation must be deterministic")
	}
	if *connection != before {
		t.Fatal("derivation must not mutate the connection aggregate")
	}
}

func TestDeriveCapabilityManifestNilConnectionMeansNotConfigured(t *testing.T) {
	manifest := DeriveCapabilityManifest(nil)
	for media, view := range map[string]CapabilityMediaView{string(MediaImage): manifest.Image, string(MediaVideo): manifest.Video} {
		assertUnavailableShape(t, media, view)
		if view.Reason != "not_configured" || view.Action != "contact_admin" {
			t.Fatalf("%s: nil connection must surface not_configured/contact_admin, got %q/%q", media, view.Reason, view.Action)
		}
	}
}

// The published image reference envelope is the authoritative upload gate:
// 256–6000 px per side, at most 36 MP, aspect within 1:3..3:1.
func TestCheckImageReferenceEnvelope(t *testing.T) {
	ptr := func(v int) *int { return &v }

	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(2048), HeightPx: ptr(2048)}); err != nil {
		t.Fatalf("standard square image must pass: %v", err)
	}
	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(6000), HeightPx: ptr(6000)}); err != nil {
		t.Fatalf("exactly 36MP must pass: %v", err)
	}
	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(6000), HeightPx: ptr(6001)}); err == nil {
		t.Fatal("above 36MP must fail")
	}
	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(6000), HeightPx: ptr(2000)}); err != nil {
		t.Fatalf("aspect 3:1 must pass: %v", err)
	}
	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(6001), HeightPx: ptr(2000)}); err == nil {
		t.Fatal("aspect beyond 3:1 must fail")
	}
	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(100), HeightPx: ptr(400)}); err == nil {
		t.Fatal("aspect narrower than 1:3 must fail")
	}
	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(255), HeightPx: ptr(765)}); err == nil {
		t.Fatal("side below 256px must fail")
	}
	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(6001), HeightPx: ptr(256)}); err == nil {
		t.Fatal("side above 6000px must fail")
	}
	if err := CheckImageReferenceEnvelope(MediaFacts{}); err == nil {
		t.Fatal("missing dimensions must fail")
	}
}
