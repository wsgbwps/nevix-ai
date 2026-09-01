package domain

// The versioned AI Provider Capability Manifest (spec #150): the server's
// authoritative declaration of supported generation capabilities. Content is
// code-versioned — it changes only with an accepted capability decision, which
// bumps ManifestVersion. The derivation below combines that static contract
// with the instance's Provider Connection facts; it is a pure function and
// never rewrites the connection.

// ManifestSchemaVersion is the wire payload's shape version
// (contracts/creation.yaml CapabilityManifest.schema_version).
const ManifestSchemaVersion = 2

// ManifestVersion is the capability content version. Bump when the accepted
// capability set changes, such as a model or vendor ratio/size contract
// change.
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

// Media mode ids as published on the wire.
const (
	ModeTextToImage    = "text-to-image"
	ModeReferenceImage = "reference-image"
	ModeTextToVideo    = "text-to-video"
	ModeFirstFrame     = "first-frame"
	ModeFirstLastFrame = "first-last-frame"
	ModeOmniReference  = "omni-reference"
)

// Manifest content is the source-controlled capability contract. Order here
// is the wire order — fixed, so one manifest version always serializes the
// same sequence. Image resolution tiers are model-scoped because the vendor
// size table differs per model.
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
	case media == string(MediaImage) && mode == ModeTextToImage:
		return ReferenceMaterialPolicy{Total: CountRange{Min: 0, Max: 0}}
	case media == string(MediaImage): // reference-image
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
	if media == string(MediaImage) {
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

// deriveAvailableMedia publishes the complete source-controlled contract for
// a media whose instance connection is available.
func deriveAvailableMedia(media string, models []CapabilityModelView, modes []string) CapabilityMediaView {
	view := CapabilityMediaView{Available: true}

	for _, mode := range modes {
		view.Modes = append(view.Modes, CapabilityModeView{ID: mode, ReferenceMaterial: modeReferencePolicy(media, mode)})
	}

	for _, model := range models {
		view.Models = append(view.Models, CapabilityModelView{
			Model:             model.Model,
			Resolutions:       append([]string(nil), model.Resolutions...),
			DefaultResolution: model.DefaultResolution,
		})
	}

	var defaults CapabilityDefaultsView
	if media == string(MediaImage) {
		view.Ratios = append([]string(nil), imageRatios...)
		view.Quantities = append([]int(nil), imageQuantities...)
		defaults.Ratio = defaultImageRatio
		defaults.Quantity = defaultImageQuantity
	} else {
		view.Durations = append([]int(nil), videoDurations...)
		defaults.Duration = defaultVideoDuration
	}

	view.Defaults = &defaults
	view.Prompt = &PromptEnvelopeView{MinChars: PromptMinChars, MaxChars: PromptMaxChars}
	envelope := mediaReferenceEnvelope(media)
	view.ReferenceMaterial = &envelope
	return view
}

// DeriveCapabilityManifest combines the source-controlled capability contract
// with the instance connection (nil when not configured). Connection check
// facts are read, never written.
func DeriveCapabilityManifest(connection *ProviderConnection) CapabilityManifestView {
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
		if instanceView.Status != MediaCapabilityAvailable {
			return CapabilityMediaView{Reason: instanceView.Reason, Action: instanceView.Action}
		}
		return deriveAvailableMedia(media, models, modes)
	}

	manifest.Image = derive(string(MediaImage), imageModels, imageModes, instance.Image)
	manifest.Video = derive(string(MediaVideo), videoModels, videoModes, instance.Video)
	return manifest
}

// MediaReferenceEnvelope returns the media-level widest reference policy so
// admission validates material facts against the same numbers the manifest
// publishes — one source, never a duplicated constant.
func MediaReferenceEnvelope(media MediaType) ReferenceMaterialPolicy {
	return mediaReferenceEnvelope(string(media))
}
