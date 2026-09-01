package domain

import "strconv"

// The versioned AI Provider Capability Manifest (spec #150): the server's
// authoritative declaration of which generation capabilities have passed
// real-invocation acceptance. Content is code-versioned — it changes only
// with an accepted capability decision, which bumps ManifestVersion. The
// derivation below is the single projection point merging the Nevix-global
// Production Readiness evidence with the instance's Provider Connection
// facts; it is a pure function and never rewrites either input.

// ManifestSchemaVersion is the wire payload's shape version
// (contracts/creation.yaml CapabilityManifest.schema_version).
const ManifestSchemaVersion = 2

// ManifestVersion is the capability content version. Bump when the accepted
// capability set changes — by acceptance (T16 evidence activates values) or
// by decision (a failed acceptance removes a value, e.g. 1080p, or the
// vendor's ratio/size contract change that removed 4:5).
const ManifestVersion = 3

// The V1 allowlisted models (spec #150). Declared here because the manifest
// publishes them; the Kapon adapter reuses these constants so the catalog
// check, the manifest, and the wire size table can never drift apart.
const (
	ImageModelID  = "doubao-seedream-5.0-pro"
	ImageModelNID = "doubao-seedream-5.0-n"
	VideoModelID  = "doubao-seedance-2-5"
)

// Prompt length envelope shared by both media (spec 图片/视频合同).
const (
	PromptMinChars = 1
	PromptMaxChars = 2000
)

// Manifest-only reason/action vocabulary; instance reasons mirror
// DeriveMediaCapabilities unchanged.
const (
	ManifestReasonReadinessPending = "production_readiness_pending"
	ManifestActionAwaitRelease     = "await_release"
)

// Media mode ids as published on the wire.
const (
	ModeTextToImage    = "text-to-image"
	ModeReferenceImage = "reference-image"
	ModeTextToVideo    = "text-to-video"
	ModeFirstFrame     = "first-frame"
	ModeFirstLastFrame = "first-last-frame"
	ModeOmniReference  = "omni-reference"
)

// Manifest content: every value binds to exactly one readiness checklist
// slot (build-time invariant enforced by manifest_test.go). Order here is
// the wire order — fixed, so one manifest version always serializes the same
// sequence. Image resolution tiers are model-scoped: the vendor size table
// differs per model, so a tier only exists on the models that declare it and
// its checklist slots bind (model, tier).
var (
	imageModes  = []string{ModeTextToImage, ModeReferenceImage}
	imageRatios = []string{"1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"}
	// imageModels declares the accepted image models and their resolution
	// tiers (Kapon size contract, apifox 2026-09): pro covers 1K/1.5K/2K,
	// n covers 2K/3K/4K; the tier labels overlap but the pixel sizes differ.
	imageModels = []CapabilityModelView{
		{Model: ImageModelID, Resolutions: []string{"1K", "1.5K", "2K"}, DefaultResolution: "2K"},
		{Model: ImageModelNID, Resolutions: []string{"2K", "3K", "4K"}, DefaultResolution: "2K"},
	}
	imageQuantities = []int{1, 2, 3, 4}

	videoModes  = []string{ModeTextToVideo, ModeFirstFrame, ModeFirstLastFrame, ModeOmniReference}
	videoModels = []CapabilityModelView{
		{Model: VideoModelID, Resolutions: []string{"480p", "720p", "1080p"}, DefaultResolution: "720p"},
	}
	videoDurations = []int{5, 10}
)

// AcceptedImageRatios and AcceptedImageModels expose the accepted value sets
// the manifest publishes, so downstream contracts (e.g. the adapter's wire
// mapping conformance) can derive their coverage from the same source
// instead of hand-copying the lists.
func AcceptedImageRatios() []string { return imageRatios }

// AcceptedImageModels returns the declared image models with their
// resolution tiers.
func AcceptedImageModels() []CapabilityModelView { return imageModels }

// Spec defaults: used when active, else the first active value in the fixed
// order above. The resolution defaults are declared per model.
const (
	defaultImageRatio    = "1:1"
	defaultImageQuantity = 1
	defaultVideoDuration = 5
)

// Checklist dimensions each media must have at least one passed value from
// before it is submittable at all — including the persistence and probe
// slots, because an output that cannot be verified and transferred never
// ships as a capability.
func manifestDimensions(media string) []string {
	if media == ReadinessMediaImage {
		return []string{"mode", "ratio", "resolution", "quantity", "transfer", "probe"}
	}
	return []string{"mode", "resolution", "duration", "reference_envelope", "async_query", "transfer", "probe"}
}

// Manifest view types (wire shapes per contracts/creation.yaml). Available
// media carry every field; unavailable media carry only reason/action, so
// value lists stay nil and pointer fields nil.
type (
	// CapabilityManifestView is the whole manifest payload.
	CapabilityManifestView struct {
		SchemaVersion   int                 `json:"schema_version"`
		ManifestVersion int                 `json:"manifest_version"`
		Image           CapabilityMediaView `json:"image"`
		Video           CapabilityMediaView `json:"video"`
	}
	// CapabilityMediaView is one media's submittable capability set, or the
	// structured unavailability the Workbench surfaces verbatim.
	CapabilityMediaView struct {
		Available         bool                     `json:"available"`
		Reason            string                   `json:"reason,omitempty"`
		Action            string                   `json:"action,omitempty"`
		Models            []CapabilityModelView    `json:"models,omitempty"`
		Modes             []CapabilityModeView     `json:"modes,omitempty"`
		Ratios            []string                 `json:"ratios,omitempty"`
		Quantities        []int                    `json:"quantities,omitempty"`
		Durations         []int                    `json:"durations,omitempty"`
		Defaults          *CapabilityDefaultsView  `json:"defaults,omitempty"`
		Prompt            *PromptEnvelopeView      `json:"prompt,omitempty"`
		ReferenceMaterial *ReferenceMaterialPolicy `json:"reference_material,omitempty"`
	}
	// CapabilityModelView is one allowlisted model and the resolution tiers
	// it publishes. Image media carries two models with disjoint tier sets;
	// video carries one.
	CapabilityModelView struct {
		Model             string   `json:"model"`
		Resolutions       []string `json:"resolutions"`
		DefaultResolution string   `json:"default_resolution"`
	}
	// CapabilityModeView is one submittable mode and its reference bounds.
	CapabilityModeView struct {
		ID                string                  `json:"id"`
		ReferenceMaterial ReferenceMaterialPolicy `json:"reference_material"`
	}
	// CapabilityDefaultsView recommends one value per media-level dimension;
	// every value is always inside the published sets. The resolution
	// default lives on each CapabilityModelView.
	CapabilityDefaultsView struct {
		Ratio    string `json:"ratio,omitempty"`
		Quantity int    `json:"quantity,omitempty"`
		Duration int    `json:"duration,omitempty"`
	}
	// PromptEnvelopeView bounds the prompt length in Unicode characters.
	PromptEnvelopeView struct {
		MinChars int `json:"min_chars"`
		MaxChars int `json:"max_chars"`
	}
	// CountRange is an inclusive min..max count.
	CountRange struct {
		Min int `json:"min"`
		Max int `json:"max"`
	}
	// ReferenceMaterialPolicy bounds reference materials: the cross-kind
	// total plus per-kind formats and envelopes. Mode policies state the
	// mode's own requirement; media-level policies state the widest bounds.
	ReferenceMaterialPolicy struct {
		Total    CountRange          `json:"total"`
		PerMedia *PerMediaReferences `json:"per_media,omitempty"`
	}
	// PerMediaReferences gathers the per-kind envelopes a policy allows.
	PerMediaReferences struct {
		Image *ImageReferencePolicy `json:"image,omitempty"`
		Video *VideoReferencePolicy `json:"video,omitempty"`
		Audio *AudioReferencePolicy `json:"audio,omitempty"`
	}
	// ImageReferencePolicy is the ordered-image envelope (spec 图片合同):
	// JPEG/PNG/WebP, ≤8 MiB for image-mode references, 256–6000 px per side,
	// ≤36 MP, aspect within 1:3..3:1.
	ImageReferencePolicy struct {
		Count     CountRange `json:"count"`
		Formats   []string   `json:"formats"`
		MaxBytes  int        `json:"max_bytes"`
		MinPx     int        `json:"min_px"`
		MaxPx     int        `json:"max_px"`
		MaxPixels int        `json:"max_pixels"`
		MinAspect float64    `json:"min_aspect"`
		MaxAspect float64    `json:"max_aspect"`
	}
	// VideoReferencePolicy is the input-video envelope (spec 视频合同):
	// MP4/H.264, ≤200 MiB, 2–30 seconds.
	VideoReferencePolicy struct {
		Count      CountRange `json:"count"`
		Formats    []string   `json:"formats"`
		MaxBytes   int        `json:"max_bytes"`
		MinSeconds int        `json:"min_seconds"`
		MaxSeconds int        `json:"max_seconds"`
	}
	// AudioReferencePolicy is the input-audio envelope (spec 视频合同):
	// MP3/WAV/M4A, ≤50 MiB, 2–30 seconds.
	AudioReferencePolicy struct {
		Count      CountRange `json:"count"`
		Formats    []string   `json:"formats"`
		MaxBytes   int        `json:"max_bytes"`
		MinSeconds int        `json:"min_seconds"`
		MaxSeconds int        `json:"max_seconds"`
	}
)

// Reference envelope byte limits. Image-mode references cap at 8 MiB; the
// video composers accept larger 10 MiB images (spec 视频合同).
const (
	imageRefMaxBytes      = 8 << 20
	videoImageRefMaxBytes = 10 << 20
	videoRefMaxBytes      = 200 << 20
	audioRefMaxBytes      = 50 << 20
)

// Image reference dimension envelope (spec 图片合同, Server 为权威校验方).
// The same bounds the manifest publishes gate every image upload.
const (
	ImageRefMinPx     = 256
	ImageRefMaxPx     = 6000
	ImageRefMaxPixels = 36_000_000
	ImageRefMinAspect = 1.0 / 3.0
	ImageRefMaxAspect = 3.0
)

// CheckImageReferenceEnvelope applies the published image reference
// dimension envelope to probed facts: each side within
// [ImageRefMinPx, ImageRefMaxPx], total pixels within [ImageRefMaxPixels],
// and aspect (width/height) within [ImageRefMinAspect, ImageRefMaxAspect].
// Byte caps and per-mode counts are gated separately (kind ceiling on
// upload, per-mode policy at admission). Facts that failed probing never
// reach this gate — callers reject them as unreadable.
func CheckImageReferenceEnvelope(facts MediaFacts) error {
	if facts.WidthPx == nil || facts.HeightPx == nil {
		return ErrReferenceOutsideEnvelope
	}
	width, height := *facts.WidthPx, *facts.HeightPx
	if width < ImageRefMinPx || width > ImageRefMaxPx ||
		height < ImageRefMinPx || height > ImageRefMaxPx {
		return ErrReferenceOutsideEnvelope
	}
	pixels := int64(width) * int64(height)
	if pixels > ImageRefMaxPixels {
		return ErrReferenceOutsideEnvelope
	}
	aspect := float64(width) / float64(height)
	if aspect < ImageRefMinAspect || aspect > ImageRefMaxAspect {
		return ErrReferenceOutsideEnvelope
	}
	return nil
}

func imageReferencePolicy(min, max, maxBytes int) ImageReferencePolicy {
	return ImageReferencePolicy{
		Count:     CountRange{Min: min, Max: max},
		Formats:   []string{"jpeg", "png", "webp"},
		MaxBytes:  maxBytes,
		MinPx:     ImageRefMinPx,
		MaxPx:     ImageRefMaxPx,
		MaxPixels: ImageRefMaxPixels,
		MinAspect: ImageRefMinAspect,
		MaxAspect: ImageRefMaxAspect,
	}
}

func videoReferencePolicy(min, max int) VideoReferencePolicy {
	return VideoReferencePolicy{
		Count:      CountRange{Min: min, Max: max},
		Formats:    []string{"mp4"},
		MaxBytes:   videoRefMaxBytes,
		MinSeconds: 2,
		MaxSeconds: 30,
	}
}

func audioReferencePolicy(min, max int) AudioReferencePolicy {
	return AudioReferencePolicy{
		Count:      CountRange{Min: min, Max: max},
		Formats:    []string{"mp3", "wav", "m4a"},
		MaxBytes:   audioRefMaxBytes,
		MinSeconds: 2,
		MaxSeconds: 30,
	}
}

func ptr[P any](p P) *P { return &p }

// modeReferencePolicy states one mode's own reference requirement. The
// composer keeps V1 video input to first/last frames and omni references
// only (spec Workbench 交互); modes are the normalized submission shapes
// (story 28).
func modeReferencePolicy(media, mode string) ReferenceMaterialPolicy {
	switch {
	case media == ReadinessMediaImage && mode == ModeTextToImage:
		return ReferenceMaterialPolicy{Total: CountRange{Min: 0, Max: 0}}
	case media == ReadinessMediaImage: // reference-image
		return ReferenceMaterialPolicy{
			Total:    CountRange{Min: 1, Max: 4},
			PerMedia: &PerMediaReferences{Image: ptr(imageReferencePolicy(1, 4, imageRefMaxBytes))},
		}
	case mode == ModeTextToVideo:
		return ReferenceMaterialPolicy{Total: CountRange{Min: 0, Max: 0}}
	case mode == ModeFirstFrame:
		return ReferenceMaterialPolicy{
			Total:    CountRange{Min: 1, Max: 1},
			PerMedia: &PerMediaReferences{Image: ptr(imageReferencePolicy(1, 1, videoImageRefMaxBytes))},
		}
	case mode == ModeFirstLastFrame:
		return ReferenceMaterialPolicy{
			Total:    CountRange{Min: 1, Max: 2},
			PerMedia: &PerMediaReferences{Image: ptr(imageReferencePolicy(1, 2, videoImageRefMaxBytes))},
		}
	default: // omni-reference
		return ReferenceMaterialPolicy{
			Total: CountRange{Min: 1, Max: 4},
			PerMedia: &PerMediaReferences{
				Image: ptr(imageReferencePolicy(0, 4, videoImageRefMaxBytes)),
				Video: ptr(videoReferencePolicy(0, 1)),
				Audio: ptr(audioReferencePolicy(0, 1)),
			},
		}
	}
}

// mediaReferenceEnvelope is the media-level widest reference policy.
func mediaReferenceEnvelope(media string) ReferenceMaterialPolicy {
	if media == ReadinessMediaImage {
		return ReferenceMaterialPolicy{
			Total:    CountRange{Min: 0, Max: 4},
			PerMedia: &PerMediaReferences{Image: ptr(imageReferencePolicy(0, 4, imageRefMaxBytes))},
		}
	}
	return ReferenceMaterialPolicy{
		Total: CountRange{Min: 0, Max: 4},
		PerMedia: &PerMediaReferences{
			Image: ptr(imageReferencePolicy(0, 4, videoImageRefMaxBytes)),
			Video: ptr(videoReferencePolicy(0, 1)),
			Audio: ptr(audioReferencePolicy(0, 1)),
		},
	}
}

// mediaReadinessActive reports whether the evidence activates a media:
// every required dimension has at least one passed slot — including the
// persistence and probe slots, because an output that cannot be verified and
// transferred never ships as a capability. Resolution tiers are model-scoped,
// so that dimension is active when any declared model has an accepted tier.
// Nothing partial ships: with the full dimension active but the spec default
// unpassed, the published default falls back to the first passed value in
// canonical order (never an unverified default, never a silent rewrite of a
// submitted draft — the manifest simply publishes exactly what is submittable
// today).
func mediaReadinessActive(evidence ReadinessEvidence, media string) bool {
	for _, dimension := range manifestDimensions(media) {
		if dimension == "resolution" {
			if !evidence.anyModelPassed(media, dimension) {
				return false
			}
			continue
		}
		if len(evidence.passedValues(media, dimension)) == 0 {
			return false
		}
	}
	return true
}

// pickDefault returns the spec default when active, else the first active
// value in the fixed canonical order. Callers guarantee at least one active.
func pickDefault(values []string, active map[string]bool, specDefault string) string {
	if active[specDefault] {
		return specDefault
	}
	for _, v := range values {
		if active[v] {
			return v
		}
	}
	return specDefault
}

func pickDefaultInt(values []int, active map[string]bool, specDefault int) int {
	if active[strconv.Itoa(specDefault)] {
		return specDefault
	}
	for _, v := range values {
		if active[strconv.Itoa(v)] {
			return v
		}
	}
	return specDefault
}

// deriveAvailableMedia builds one media's view when both the readiness gate
// and the instance connection allow it, publishing exactly the passed values
// in fixed order with in-set defaults. Each declared model publishes only its
// own accepted resolution tiers; a model without any accepted tier is not
// published at all.
func deriveAvailableMedia(evidence ReadinessEvidence, media string, models []CapabilityModelView, modes []string) CapabilityMediaView {
	view := CapabilityMediaView{Available: true}

	modeActive := evidence.passedValues(media, "mode")
	for _, mode := range modes {
		if modeActive[mode] {
			view.Modes = append(view.Modes, CapabilityModeView{ID: mode, ReferenceMaterial: modeReferencePolicy(media, mode)})
		}
	}

	for _, model := range models {
		tierActive := evidence.passedValuesForModel(media, "resolution", model.Model)
		published := CapabilityModelView{Model: model.Model}
		for _, tier := range model.Resolutions {
			if tierActive[tier] {
				published.Resolutions = append(published.Resolutions, tier)
			}
		}
		if len(published.Resolutions) == 0 {
			continue
		}
		published.DefaultResolution = pickDefault(model.Resolutions, tierActive, model.DefaultResolution)
		view.Models = append(view.Models, published)
	}

	var defaults CapabilityDefaultsView
	if media == ReadinessMediaImage {
		ratioActive := evidence.passedValues(media, "ratio")
		for _, r := range imageRatios {
			if ratioActive[r] {
				view.Ratios = append(view.Ratios, r)
			}
		}
		quantityActive := evidence.passedValues(media, "quantity")
		for _, q := range imageQuantities {
			if quantityActive[strconv.Itoa(q)] {
				view.Quantities = append(view.Quantities, q)
			}
		}
		defaults.Ratio = pickDefault(imageRatios, ratioActive, defaultImageRatio)
		defaults.Quantity = pickDefaultInt(imageQuantities, quantityActive, defaultImageQuantity)
	} else {
		durationActive := evidence.passedValues(media, "duration")
		for _, d := range videoDurations {
			if durationActive[strconv.Itoa(d)] {
				view.Durations = append(view.Durations, d)
			}
		}
		defaults.Duration = pickDefaultInt(videoDurations, durationActive, defaultVideoDuration)
	}

	view.Defaults = &defaults
	view.Prompt = &PromptEnvelopeView{MinChars: PromptMinChars, MaxChars: PromptMaxChars}
	envelope := mediaReferenceEnvelope(media)
	view.ReferenceMaterial = &envelope
	return view
}

// DeriveCapabilityManifest merges the Nevix-global readiness evidence with
// the instance connection (nil when not configured) into the current
// manifest view. Precedence is fixed so one state yields one stable answer:
// the global readiness gate first, then the instance's own projection.
// Instance check facts are read, never written — readiness cannot rewrite a
// connection's credential or capability states.
func DeriveCapabilityManifest(evidence ReadinessEvidence, connection *ProviderConnection) CapabilityManifestView {
	var instance MediaCapabilitiesView
	if connection == nil {
		instance = DeriveMediaCapabilities(nil)
	} else {
		instance = DeriveMediaCapabilities(connection)
	}

	manifest := CapabilityManifestView{
		SchemaVersion:   ManifestSchemaVersion,
		ManifestVersion: ManifestVersion,
	}

	derive := func(media string, models []CapabilityModelView, modes []string, instanceView MediaCapabilityView) CapabilityMediaView {
		switch {
		case !mediaReadinessActive(evidence, media):
			return CapabilityMediaView{Reason: ManifestReasonReadinessPending, Action: ManifestActionAwaitRelease}
		case instanceView.Status != MediaCapabilityAvailable:
			return CapabilityMediaView{Reason: instanceView.Reason, Action: instanceView.Action}
		default:
			return deriveAvailableMedia(evidence, media, models, modes)
		}
	}

	manifest.Image = derive(ReadinessMediaImage, imageModels, imageModes, instance.Image)
	manifest.Video = derive(ReadinessMediaVideo, videoModels, videoModes, instance.Video)
	return manifest
}

// MediaReferenceEnvelope returns the media-level widest reference policy so
// admission validates material facts against the same numbers the manifest
// publishes — one source, never a duplicated constant.
func MediaReferenceEnvelope(media MediaType) ReferenceMaterialPolicy {
	return mediaReferenceEnvelope(string(media))
}
