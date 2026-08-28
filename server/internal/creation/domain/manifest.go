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
const ManifestSchemaVersion = 1

// ManifestVersion is the capability content version. Bump when the accepted
// capability set changes — by acceptance (T16 evidence activates values) or
// by decision (a failed acceptance removes a value, e.g. 1080p).
const ManifestVersion = 1

// The V1 allowlisted models (spec #150). Declared here because the manifest
// publishes them; the Kapon adapter reuses these constants so the catalog
// check and the manifest can never drift apart.
const (
	ImageModelID = "doubao-seedream-5.0-lite"
	VideoModelID = "doubao-seedance-2-5"
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
// sequence.
var (
	imageModes       = []string{ModeTextToImage, ModeReferenceImage}
	imageRatios      = []string{"1:1", "4:3", "4:5", "16:9", "9:16"}
	imageResolutions = []string{"1K", "2K", "4K"}
	imageQuantities  = []int{1, 2, 3, 4}

	videoModes       = []string{ModeTextToVideo, ModeFirstFrame, ModeFirstLastFrame, ModeOmniReference}
	videoResolutions = []string{"480p", "720p", "1080p"}
	videoDurations   = []int{5, 10}
)

// Spec defaults: used when active, else the first active value in the fixed
// order above.
const (
	defaultImageRatio      = "1:1"
	defaultImageResolution = "2K"
	defaultImageQuantity   = 1
	defaultVideoResolution = "720p"
	defaultVideoDuration   = 5
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
		Model             string                   `json:"model,omitempty"`
		Modes             []CapabilityModeView     `json:"modes,omitempty"`
		Ratios            []string                 `json:"ratios,omitempty"`
		Resolutions       []string                 `json:"resolutions,omitempty"`
		Quantities        []int                    `json:"quantities,omitempty"`
		Durations         []int                    `json:"durations,omitempty"`
		Defaults          *CapabilityDefaultsView  `json:"defaults,omitempty"`
		Prompt            *PromptEnvelopeView      `json:"prompt,omitempty"`
		ReferenceMaterial *ReferenceMaterialPolicy `json:"reference_material,omitempty"`
	}
	// CapabilityModeView is one submittable mode and its reference bounds.
	CapabilityModeView struct {
		ID                string                  `json:"id"`
		ReferenceMaterial ReferenceMaterialPolicy `json:"reference_material"`
	}
	// CapabilityDefaultsView recommends one value per dimension; every value
	// is always inside the published sets.
	CapabilityDefaultsView struct {
		Ratio      string `json:"ratio,omitempty"`
		Resolution string `json:"resolution"`
		Quantity   int    `json:"quantity,omitempty"`
		Duration   int    `json:"duration,omitempty"`
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

func imageReferencePolicy(min, max, maxBytes int) ImageReferencePolicy {
	return ImageReferencePolicy{
		Count:     CountRange{Min: min, Max: max},
		Formats:   []string{"jpeg", "png", "webp"},
		MaxBytes:  maxBytes,
		MinPx:     256,
		MaxPx:     6000,
		MaxPixels: 36_000_000,
		MinAspect: 1.0 / 3.0,
		MaxAspect: 3.0,
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
// transferred never ships as a capability. Nothing partial ships: with the
// full dimension active but the spec default unpassed, the published default
// falls back to the first passed value in canonical order (never an
// unverified default, never a silent rewrite of a submitted draft — the
// manifest simply publishes exactly what is submittable today).
func mediaReadinessActive(evidence ReadinessEvidence, media string) bool {
	for _, dimension := range manifestDimensions(media) {
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
// and the instance connection allow it, publishing exactly the passed
// values in fixed order with in-set defaults.
func deriveAvailableMedia(evidence ReadinessEvidence, media, model string, modes []string) CapabilityMediaView {
	view := CapabilityMediaView{Available: true, Model: model}

	modeActive := evidence.passedValues(media, "mode")
	for _, mode := range modes {
		if modeActive[mode] {
			view.Modes = append(view.Modes, CapabilityModeView{ID: mode, ReferenceMaterial: modeReferencePolicy(media, mode)})
		}
	}

	resolutions := imageResolutions
	if media == ReadinessMediaVideo {
		resolutions = videoResolutions
	}
	resolutionActive := evidence.passedValues(media, "resolution")
	for _, r := range resolutions {
		if resolutionActive[r] {
			view.Resolutions = append(view.Resolutions, r)
		}
	}
	defaultResolution := defaultImageResolution
	if media == ReadinessMediaVideo {
		defaultResolution = defaultVideoResolution
	}
	defaults := CapabilityDefaultsView{Resolution: pickDefault(resolutions, resolutionActive, defaultResolution)}

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

	derive := func(media, model string, modes []string, instanceView MediaCapabilityView) CapabilityMediaView {
		switch {
		case !mediaReadinessActive(evidence, media):
			return CapabilityMediaView{Reason: ManifestReasonReadinessPending, Action: ManifestActionAwaitRelease}
		case instanceView.Status != MediaCapabilityAvailable:
			return CapabilityMediaView{Reason: instanceView.Reason, Action: instanceView.Action}
		default:
			return deriveAvailableMedia(evidence, media, model, modes)
		}
	}

	manifest.Image = derive(ReadinessMediaImage, ImageModelID, imageModes, instance.Image)
	manifest.Video = derive(ReadinessMediaVideo, VideoModelID, videoModes, instance.Video)
	return manifest
}
