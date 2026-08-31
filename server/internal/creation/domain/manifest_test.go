package domain

import (
	"math/rand"
	"reflect"
	"strconv"
	"testing"
)

// fullEvidence returns evidence passing every checklist slot (the state a
// deployment reaches once T16 has executed the whole checklist).
func fullEvidence() ReadinessEvidence {
	slots, err := readinessChecklist()
	if err != nil {
		panic(err)
	}
	e := ReadinessEvidence{}
	for _, slot := range slots {
		e.Entries = append(e.Entries, EvidenceEntry{SlotID: slot.ID, Status: EvidencePassed})
	}
	return e
}

// evidencePassing builds evidence from (media, dimension, value) triples.
func evidencePassing(bindings ...[3]string) ReadinessEvidence {
	e := ReadinessEvidence{}
	for _, b := range bindings {
		slot, ok := readinessSlotForValue(b[0], b[1], b[2])
		if !ok {
			panic("test binding has no slot: " + b[0] + "/" + b[1] + "/" + b[2])
		}
		e.Entries = append(e.Entries, EvidenceEntry{SlotID: slot.ID, Status: EvidencePassed})
	}
	return e
}

func TestReadinessChecklistRegistryParses(t *testing.T) {
	slots, err := readinessChecklist()
	if err != nil {
		t.Fatalf("embedded checklist must parse: %v", err)
	}
	seen := map[string]bool{}
	for _, slot := range slots {
		if slot.ID == "" || slot.Media == "" || slot.Dimension == "" || slot.Value == "" {
			t.Fatalf("slot %q is missing identity fields", slot.ID)
		}
		if seen[slot.ID] {
			t.Fatalf("duplicate slot id %q", slot.ID)
		}
		seen[slot.ID] = true
	}
	if len(seen) == 0 {
		t.Fatal("embedded checklist must not be empty")
	}
}

// TestManifestContentBindsEveryChecklistValue is the build-time invariant:
// every checklist value slot resolves, and every declared manifest value has
// exactly one slot. A typo on either side fails here instead of shipping an
// unstated capability.
func TestManifestContentBindsEveryChecklistValue(t *testing.T) {
	slots, err := readinessChecklist()
	if err != nil {
		t.Fatalf("embedded checklist must parse: %v", err)
	}
	bound := map[string]bool{}
	for _, slot := range slots {
		got, ok := readinessSlotForValue(slot.Media, slot.Dimension, slot.Value)
		if !ok || got.ID != slot.ID {
			t.Fatalf("slot %q does not resolve from its own binding", slot.ID)
		}
		bound[slot.Media+"|"+slot.Dimension+"|"+slot.Value] = true
	}

	check := func(media, dimension string, values ...string) {
		t.Helper()
		for _, v := range values {
			if !bound[media+"|"+dimension+"|"+v] {
				t.Fatalf("%s %s %q has no checklist slot", media, dimension, v)
			}
		}
	}
	check("image", "mode", imageModes...)
	check("image", "ratio", imageRatios...)
	check("image", "resolution", imageResolutions...)
	for _, q := range imageQuantities {
		check("image", "quantity", strconv.Itoa(q))
	}
	check("video", "mode", videoModes...)
	check("video", "resolution", videoResolutions...)
	for _, d := range videoDurations {
		check("video", "duration", strconv.Itoa(d))
	}

	// Reverse direction: no slot may declare a value outside the manifest
	// content (that would silently gate nothing).
	declared := map[string]bool{}
	remember := func(media, dimension string, values ...string) {
		for _, v := range values {
			declared[media+"|"+dimension+"|"+v] = true
		}
	}
	remember("image", "mode", imageModes...)
	remember("image", "ratio", imageRatios...)
	remember("image", "resolution", imageResolutions...)
	remember("video", "mode", videoModes...)
	remember("video", "resolution", videoResolutions...)
	for _, slot := range slots {
		switch slot.Dimension {
		case "mode", "ratio", "resolution":
			if !declared[slot.Media+"|"+slot.Dimension+"|"+slot.Value] {
				t.Fatalf("slot %q gates undeclared %s %s %q", slot.ID, slot.Media, slot.Dimension, slot.Value)
			}
		case "quantity":
			if slot.Media != "image" {
				t.Fatalf("quantity slots are image-only: %q", slot.ID)
			}
			n, err := strconv.Atoi(slot.Value)
			if err != nil || !containsInt(imageQuantities, n) {
				t.Fatalf("slot %q gates undeclared quantity %q", slot.ID, slot.Value)
			}
		case "duration":
			if slot.Media != "video" {
				t.Fatalf("duration slots are video-only: %q", slot.ID)
			}
			n, err := strconv.Atoi(slot.Value)
			if err != nil || !containsInt(videoDurations, n) {
				t.Fatalf("slot %q gates undeclared duration %q", slot.ID, slot.Value)
			}
		}
	}
}

func containsInt(values []int, want int) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}

// connectionState enumerates the instance states the merge must handle.
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
	if view.Model != "" || view.Modes != nil || view.Ratios != nil || view.Resolutions != nil ||
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
	if view.Model == "" {
		t.Fatalf("%s: available view must publish its allowlisted model", media)
	}
	if len(view.Modes) == 0 || len(view.Resolutions) == 0 || view.Defaults == nil || view.Prompt == nil || view.ReferenceMaterial == nil {
		t.Fatalf("%s: available view must publish modes, resolutions, defaults, prompt and reference policy", media)
	}
	if view.Prompt.MinChars != PromptMinChars || view.Prompt.MaxChars != PromptMaxChars {
		t.Fatalf("%s: prompt envelope must mirror the spec contract", media)
	}
}

// TestDeriveManifestFullReadinessProperties walks the whole instance state
// space with full evidence: the readiness gate never fires, and the manifest
// verdict is exactly the instance's own verdict.
func TestDeriveManifestFullReadinessProperties(t *testing.T) {
	evidence := fullEvidence()
	for _, connection := range connectionStates() {
		manifest := DeriveCapabilityManifest(evidence, connection)
		if manifest.SchemaVersion != ManifestSchemaVersion || manifest.ManifestVersion != ManifestVersion {
			t.Fatalf("manifest versions must always be published")
		}
		instance := DeriveMediaCapabilities(connection)
		for media, view := range map[string]CapabilityMediaView{"image": manifest.Image, "video": manifest.Video} {
			instanceView := instance.Image
			if media == "video" {
				instanceView = instance.Video
			}
			if instanceView.Status != MediaCapabilityAvailable {
				assertUnavailableShape(t, media, view)
				if view.Reason != instanceView.Reason || view.Action != instanceView.Action {
					t.Fatalf("%s: manifest must mirror the instance projection %q/%q, got %q/%q",
						media, instanceView.Reason, instanceView.Action, view.Reason, view.Action)
				}
			} else {
				assertAvailableShape(t, media, view)
			}
		}
	}
}

// TestDeriveManifestNoReadinessProperties walks the whole instance state
// space with empty evidence: every media is readiness-pending regardless of
// the instance, and the reason never claims an instance cause.
func TestDeriveManifestNoReadinessProperties(t *testing.T) {
	var evidence ReadinessEvidence
	states := append([]*ProviderConnection{nil}, connectionStates()...)
	for _, connection := range states {
		manifest := DeriveCapabilityManifest(evidence, connection)
		for media, view := range map[string]CapabilityMediaView{"image": manifest.Image, "video": manifest.Video} {
			assertUnavailableShape(t, media, view)
			if view.Reason != ManifestReasonReadinessPending || view.Action != ManifestActionAwaitRelease {
				t.Fatalf("%s: pending readiness must dominate, got %q/%q", media, view.Reason, view.Action)
			}
		}
	}
}

// TestDeriveManifestPublishedValuesArePassed is the core manifest invariant:
// with partial evidence, an available media publishes exactly the passed
// values, in canonical order, with defaults inside the published sets.
func TestDeriveManifestPublishedValuesArePassed(t *testing.T) {
	evidence := evidencePassing(
		[3]string{"image", "mode", ModeTextToImage},
		[3]string{"image", "mode", ModeReferenceImage},
		[3]string{"image", "ratio", "1:1"},
		[3]string{"image", "ratio", "4:5"},
		[3]string{"image", "resolution", "1K"},
		[3]string{"image", "resolution", "2K"},
		[3]string{"image", "quantity", "1"},
		[3]string{"image", "quantity", "3"},
		[3]string{"image", "transfer", "temp-url"},
		[3]string{"image", "probe", "png"},
		// video: not passed at all
	)
	connection := &ProviderConnection{
		ID: NewUUID(), AdminState: AdminStateEnabled, CredentialState: CredentialStateValid,
		ImageCapability: MediaCapabilityAvailable, VideoCapability: MediaCapabilityAvailable,
	}
	manifest := DeriveCapabilityManifest(evidence, connection)

	assertAvailableShape(t, "image", manifest.Image)
	image := manifest.Image
	wantModes := []string{ModeTextToImage, ModeReferenceImage}
	if !reflect.DeepEqual(imageModeIDs(image.Modes), wantModes) {
		t.Fatalf("image modes = %v, want %v", imageModeIDs(image.Modes), wantModes)
	}
	if !reflect.DeepEqual(image.Ratios, []string{"1:1", "4:5"}) {
		t.Fatalf("image ratios must publish exactly the passed values in canonical order, got %v", image.Ratios)
	}
	if !reflect.DeepEqual(image.Resolutions, []string{"1K", "2K"}) {
		t.Fatalf("image resolutions must publish exactly the passed values, got %v", image.Resolutions)
	}
	if !reflect.DeepEqual(image.Quantities, []int{1, 3}) {
		t.Fatalf("image quantities must publish exactly the passed values, got %v", image.Quantities)
	}
	if image.Defaults.Ratio != "1:1" || image.Defaults.Resolution != "2K" || image.Defaults.Quantity != 1 {
		t.Fatalf("image defaults must fall inside the published sets, got %+v", image.Defaults)
	}
	for _, mode := range image.Modes {
		if mode.ReferenceMaterial.Total.Max < mode.ReferenceMaterial.Total.Min {
			t.Fatalf("mode %s reference bounds must be well formed", mode.ID)
		}
	}

	assertUnavailableShape(t, "video", manifest.Video)
	if manifest.Video.Reason != ManifestReasonReadinessPending {
		t.Fatalf("video with no evidence must be readiness-pending, got %q", manifest.Video.Reason)
	}
}

func imageModeIDs(modes []CapabilityModeView) []string {
	ids := make([]string, 0, len(modes))
	for _, m := range modes {
		ids = append(ids, m.ID)
	}
	return ids
}

// TestDeriveManifestDefaultsFallBackWhenSpecDefaultUnpassed proves the
// fallback is deterministic and never publishes an unverified default: with
// 720p unpassed but every other video dimension ready, the manifest is
// available and its default resolution is the first passed value (480p).
func TestDeriveManifestDefaultsFallBackWhenSpecDefaultUnpassed(t *testing.T) {
	bindings := [][3]string{
		{"video", "mode", ModeTextToVideo},
		{"video", "resolution", "480p"},
		{"video", "duration", "5"},
		{"video", "reference_envelope", "omni-max-combo"},
		{"video", "async_query", "poll"},
		{"video", "transfer", "temp-url"},
		{"video", "probe", "mp4"},
		{"video", "probe", "audio-track"},
	}
	connection := &ProviderConnection{
		ID: NewUUID(), AdminState: AdminStateEnabled, CredentialState: CredentialStateValid,
		ImageCapability: MediaCapabilityUnavailable, VideoCapability: MediaCapabilityAvailable,
	}
	manifest := DeriveCapabilityManifest(evidencePassing(bindings...), connection)
	assertAvailableShape(t, "video", manifest.Video)
	if containsString(manifest.Video.Resolutions, "720p") || !containsString(manifest.Video.Resolutions, "480p") {
		t.Fatalf("video must publish only the passed resolutions, got %v", manifest.Video.Resolutions)
	}
	if manifest.Video.Defaults.Resolution != "480p" {
		t.Fatalf("video default resolution must fall back to the first passed value, got %q", manifest.Video.Defaults.Resolution)
	}
	assertUnavailableShape(t, "image", manifest.Image)
}

// TestManifestDimensionsCoverEveryChecklistDimension closes the drift gap
// between the checklist document and the activation gate: a dimension that
// exists in the checklist must participate in its media's gate, or adding a
// checklist dimension would silently gate nothing.
func TestManifestDimensionsCoverEveryChecklistDimension(t *testing.T) {
	slots, err := readinessChecklist()
	if err != nil {
		t.Fatalf("embedded checklist must parse: %v", err)
	}
	for _, slot := range slots {
		dimensions := manifestDimensions(slot.Media)
		if !containsString(dimensions, slot.Dimension) {
			t.Fatalf("checklist dimension %q (slot %s) is not part of the %s activation gate %v",
				slot.Dimension, slot.ID, slot.Media, dimensions)
		}
	}
}

// TestDeriveManifestImageVideoIndependence proves per-media evidence cannot
// leak across media: video evidence alone leaves image readiness-pending.
func TestDeriveManifestImageVideoIndependence(t *testing.T) {
	videoOnly := evidencePassing(
		[3]string{"video", "mode", ModeTextToVideo},
		[3]string{"video", "resolution", "720p"},
		[3]string{"video", "duration", "5"},
		[3]string{"video", "reference_envelope", "omni-max-combo"},
		[3]string{"video", "async_query", "poll"},
		[3]string{"video", "transfer", "temp-url"},
		[3]string{"video", "probe", "mp4"},
		[3]string{"video", "probe", "audio-track"},
	)
	manifest := DeriveCapabilityManifest(videoOnly, nil)
	assertUnavailableShape(t, "image", manifest.Image)
	if manifest.Image.Reason != ManifestReasonReadinessPending {
		t.Fatalf("image must be readiness-pending, got %q", manifest.Image.Reason)
	}
	// Full evidence flips both regardless of order.
	both := fullEvidence()
	manifest = DeriveCapabilityManifest(both, nil)
	assertUnavailableShape(t, "image", manifest.Image)
	assertUnavailableShape(t, "video", manifest.Video)
}

// TestDeriveManifestIsPureAndDeterministic: same inputs give identical
// outputs and neither input is mutated (readiness must not rewrite instance
// facts even in memory).
func TestDeriveManifestIsPureAndDeterministic(t *testing.T) {
	evidence := fullEvidence()
	connection := &ProviderConnection{
		ID: NewUUID(), AdminState: AdminStateEnabled, CredentialState: CredentialStateValid,
		ImageCapability: MediaCapabilityAvailable, VideoCapability: MediaCapabilityUnavailable,
		Envelope: ptr(ProviderCredentialEnvelope{Version: 1, KeyID: "k", Nonce: []byte{1}, Ciphertext: []byte{2}}),
	}
	before := *connection
	first := DeriveCapabilityManifest(evidence, connection)
	second := DeriveCapabilityManifest(evidence, connection)
	if !reflect.DeepEqual(first, second) {
		t.Fatal("derivation must be deterministic")
	}
	if *connection != before {
		t.Fatal("derivation must not mutate the connection aggregate")
	}
}

// TestDeriveManifestTransientStatesSurfacesChecking: an instance in
// checking surfaces checking through the manifest instead of inventing an
// availability verdict.
func TestDeriveManifestTransientStatesSurfacesChecking(t *testing.T) {
	evidence := fullEvidence()
	connection := &ProviderConnection{
		ID: NewUUID(), AdminState: AdminStateEnabled, CredentialState: CredentialStateChecking,
		ImageCapability: MediaCapabilityChecking, VideoCapability: MediaCapabilityChecking,
	}
	manifest := DeriveCapabilityManifest(evidence, connection)
	for media, view := range map[string]CapabilityMediaView{"image": manifest.Image, "video": manifest.Video} {
		assertUnavailableShape(t, media, view)
		if view.Reason != "checking" || view.Action != "wait" {
			t.Fatalf("%s: checking instance must surface checking/wait, got %q/%q", media, view.Reason, view.Action)
		}
	}
}

// TestDeriveManifestNilConnectionMeansNotConfigured keeps the member-facing
// cause honest when no connection exists at all.
func TestDeriveManifestNilConnectionMeansNotConfigured(t *testing.T) {
	manifest := DeriveCapabilityManifest(fullEvidence(), nil)
	for media, view := range map[string]CapabilityMediaView{"image": manifest.Image, "video": manifest.Video} {
		assertUnavailableShape(t, media, view)
		if view.Reason != "not_configured" || view.Action != "contact_admin" {
			t.Fatalf("%s: nil connection must surface not_configured/contact_admin, got %q/%q", media, view.Reason, view.Action)
		}
	}
}

// TestDeriveManifestRandomizedProperties is the seeded property sweep: for
// arbitrary evidence subsets crossed with arbitrary instance states, the
// manifest never publishes an unpassed value, never invents a reason outside
// the merged projections, and keeps the two media independent.
func TestDeriveManifestRandomizedProperties(t *testing.T) {
	rng := rand.New(rand.NewSource(158)) // fixed seed: failures reproduce
	slots, err := readinessChecklist()
	if err != nil {
		t.Fatalf("embedded checklist must parse: %v", err)
	}

	reasons := map[string]bool{
		ManifestReasonReadinessPending: true, "not_configured": true, "checking": true,
		"credential_invalid": true, "credential_unavailable": true,
		"connection_paused": true, "model_unavailable": true,
	}
	actions := map[string]bool{"wait": true, "await_release": true, "contact_admin": true}

	for round := 0; round < 500; round++ {
		evidence := ReadinessEvidence{}
		for _, slot := range slots {
			if rng.Intn(2) == 0 {
				status := EvidencePassed
				if rng.Intn(4) == 0 {
					status = EvidenceFailed
				}
				evidence.Entries = append(evidence.Entries, EvidenceEntry{SlotID: slot.ID, Status: status})
			}
		}
		var connection *ProviderConnection
		if rng.Intn(4) > 0 {
			states := connectionStates()
			connection = states[rng.Intn(len(states))]
		}
		manifest := DeriveCapabilityManifest(evidence, connection)

		for media, view := range map[string]CapabilityMediaView{"image": manifest.Image, "video": manifest.Video} {
			if !view.Available {
				assertUnavailableShape(t, media, view)
				if !reasons[view.Reason] || !actions[view.Action] {
					t.Fatalf("round %d: %s surfaced unknown reason/action %q/%q", round, media, view.Reason, view.Action)
				}
				continue
			}
			assertAvailableShape(t, media, view)
			assertValuesPassed(t, round, media, evidence, view)
			assertDefaultsInsidePublished(t, round, media, view)
		}

		// Independence: empty image evidence always keeps image pending,
		// whatever the video side or instance says.
		imageAlone := DeriveCapabilityManifest(ReadinessEvidence{}, connection).Image
		if imageAlone.Reason != ManifestReasonReadinessPending {
			t.Fatalf("round %d: empty image evidence must keep image pending, got %q", round, imageAlone.Reason)
		}
	}
}

// assertValuesPassed checks every published value's slot is passed.
func assertValuesPassed(t *testing.T, round int, media string, evidence ReadinessEvidence, view CapabilityMediaView) {
	t.Helper()
	check := func(dimension, value string) {
		t.Helper()
		if _, ok := readinessSlotForValue(media, dimension, value); !ok {
			t.Fatalf("round %d: %s %s %q has no slot", round, media, dimension, value)
		}
		if !evidence.passedValues(media, dimension)[value] {
			t.Fatalf("round %d: %s published unpassed value %s=%q", round, media, dimension, value)
		}
	}
	for _, mode := range view.Modes {
		check("mode", mode.ID)
	}
	for _, r := range view.Ratios {
		check("ratio", r)
	}
	for _, r := range view.Resolutions {
		check("resolution", r)
	}
	for _, q := range view.Quantities {
		check("quantity", strconv.Itoa(q))
	}
	for _, d := range view.Durations {
		check("duration", strconv.Itoa(d))
	}
}

// assertDefaultsInsidePublished checks every default is a member of its
// published set, so a composer following defaults never offers an
// unsubmittable value.
func assertDefaultsInsidePublished(t *testing.T, round int, media string, view CapabilityMediaView) {
	t.Helper()
	defaults := view.Defaults
	if !containsString(view.Resolutions, defaults.Resolution) {
		t.Fatalf("round %d: %s default resolution %q is outside published set", round, media, defaults.Resolution)
	}
	if media == "image" {
		if !containsString(view.Ratios, defaults.Ratio) {
			t.Fatalf("round %d: image default ratio %q is outside published set", round, defaults.Ratio)
		}
		if !containsInt(view.Quantities, defaults.Quantity) {
			t.Fatalf("round %d: image default quantity %d is outside published set", round, defaults.Quantity)
		}
	} else if !containsInt(view.Durations, defaults.Duration) {
		t.Fatalf("round %d: video default duration %d is outside published set", round, defaults.Duration)
	}
}

func containsString(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}

// The published image reference envelope (spec 图片合同) is the authoritative
// upload gate: 256–6000 px per side, ≤36 MP, aspect within 1:3..3:1.
func TestCheckImageReferenceEnvelope(t *testing.T) {
	ptr := func(v int) *int { return &v }

	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(2048), HeightPx: ptr(2048)}); err != nil {
		t.Fatalf("standard square image must pass: %v", err)
	}
	// The 36 MP bound is inclusive; one extra pixel row overflows it.
	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(6000), HeightPx: ptr(6000)}); err != nil {
		t.Fatalf("exactly 36MP must pass: %v", err)
	}
	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(6000), HeightPx: ptr(6001)}); err == nil {
		t.Fatal("above 36MP must fail")
	}
	// The aspect bounds are inclusive at 1:3 and 3:1.
	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(6000), HeightPx: ptr(2000)}); err != nil {
		t.Fatalf("aspect 3:1 must pass: %v", err)
	}
	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(6001), HeightPx: ptr(2000)}); err == nil {
		t.Fatal("aspect beyond 3:1 must fail")
	}
	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(100), HeightPx: ptr(400)}); err == nil {
		t.Fatal("aspect narrower than 1:3 must fail")
	}
	// Sides outside [256, 6000] fail regardless of aspect.
	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(255), HeightPx: ptr(765)}); err == nil {
		t.Fatal("side below 256px must fail")
	}
	if err := CheckImageReferenceEnvelope(MediaFacts{WidthPx: ptr(6001), HeightPx: ptr(256)}); err == nil {
		t.Fatal("side above 6000px must fail")
	}
	// Unprobed facts never pass the gate.
	if err := CheckImageReferenceEnvelope(MediaFacts{}); err == nil {
		t.Fatal("missing dimensions must fail")
	}
}
