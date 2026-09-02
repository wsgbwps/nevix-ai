package domain

import (
	"time"
	"unicode/utf8"
)

// Session is a creator-private Creation Session aggregate root. Its only
// state transitions are creation, rename, and the logical delete that hides
// it immediately and blocks every future generation entry; nothing about its
// lifecycle reopens or mutates history after deletion (ADR-0016).
type Session struct {
	ID        UUID
	OwnerID   UUID
	Name      string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Draft media type is the generation target media of the composer. The
// database CHECK mirrors this closed set.
type DraftMediaType string

const (
	DraftMediaImage DraftMediaType = "image"
	DraftMediaVideo DraftMediaType = "video"
)

// DraftRole is the part one reference material plays in the draft intent.
// Image references and the video frame slots only take images; omni
// references accept every material kind. The database CHECK mirrors the
// closed set.
type DraftRole string

const (
	RoleReference  DraftRole = "reference"
	RoleFirstFrame DraftRole = "first_frame"
	RoleLastFrame  DraftRole = "last_frame"
	RoleOmni       DraftRole = "omni"
)

// AcceptsKind reports whether a material kind can fill the role.
func (r DraftRole) AcceptsKind(k Kind) bool {
	switch r {
	case RoleReference, RoleFirstFrame, RoleLastFrame:
		return k == KindImage
	case RoleOmni:
		return k == KindImage || k == KindVideo || k == KindAudio
	default:
		return false
	}
}

// Structural intent envelope (contracts/creation.yaml TaskSubmitInput). The
// bounds here are deliberately wider than any single manifest version: a
// device-local draft may carry stale values between sessions, so structural
// acceptance stays permissive while manifest conformance belongs to the
// admission freeze.
const (
	DraftPromptMaxChars = 2000
	DraftModelMaxChars  = 128
	DraftModeMaxChars   = 64
	DraftValueMaxChars  = 16
	// The widest reference ceiling any manifest version may publish: the
	// base image model's 14 (manifest v5). Per-model conformance belongs to
	// the admission freeze.
	DraftMaxReferenceFrames = 14
)

// DraftReference is one ordered material binding of the submitted intent;
// slice order in GenerationIntent.References is the pile order.
type DraftReference struct {
	MaterialID UUID
	Role       DraftRole
}

// GenerationIntent is the complete generation intent a submission carries
// (ADR-0017): the device-local draft's values at submit time — prompt, target
// media, the manifest version the composer rendered, the model/mode/parameters
// as chosen, and the ordered reference bindings. The server never stores it
// editable: admission validates the envelope, freezes the intent against the
// live manifest into a GenerationSpecification, and the intent dies with the
// request. Nil pointers mean the field is unset, not empty — an unset value
// and a submitted zero are different intent facts.
type GenerationIntent struct {
	Prompt          string
	MediaType       *DraftMediaType
	ManifestVersion int
	Model           *string
	Mode            *string
	Ratio           *string
	Resolution      *string
	Quantity        *int
	DurationSeconds *int
	References      []DraftReference
}

// Validate enforces the structural intent envelope. It never consults the
// capability manifest: stale-but-wellformed values reach the freeze, which
// rejects them there.
func (i *GenerationIntent) Validate() error {
	if utf8.RuneCountInString(i.Prompt) > DraftPromptMaxChars {
		return ErrInvalidIntent
	}
	if i.MediaType != nil && *i.MediaType != DraftMediaImage && *i.MediaType != DraftMediaVideo {
		return ErrInvalidIntent
	}
	if i.ManifestVersion < 1 {
		return ErrInvalidIntent
	}
	// Each field checks against its own named bound — never via pointer
	// identity — so aliased pointers cannot swap one field's limit for
	// another's and turn a 400 into a database-check 500.
	if overLimit(i.Model, DraftModelMaxChars) || overLimit(i.Mode, DraftModeMaxChars) ||
		overLimit(i.Ratio, DraftValueMaxChars) || overLimit(i.Resolution, DraftValueMaxChars) {
		return ErrInvalidIntent
	}
	if i.Quantity != nil && (*i.Quantity < 1 || *i.Quantity > 4) {
		return ErrInvalidIntent
	}
	if i.DurationSeconds != nil && *i.DurationSeconds < 1 {
		return ErrInvalidIntent
	}
	if len(i.References) > DraftMaxReferenceFrames {
		return ErrInvalidIntent
	}
	for _, reference := range i.References {
		switch reference.Role {
		case RoleReference, RoleFirstFrame, RoleLastFrame, RoleOmni:
		default:
			return ErrInvalidIntent
		}
	}
	return nil
}

func overLimit(text *string, limit int) bool {
	return text != nil && utf8.RuneCountInString(*text) > limit
}

// ReferenceMaterial is one creator-private reference asset: a verified media
// file whose rights facts were recorded atomically by the uploading action.
// The struct is immutable once written — no V1 command edits material facts.
type ReferenceMaterial struct {
	ID             UUID
	SessionID      UUID
	Kind           Kind
	FileName       string
	MimeType       string
	ByteSize       int64
	ChecksumSHA256 []byte
	BlobKey        string
	WidthPx        *int
	HeightPx       *int
	PixelCount     *int64
	DurationMS     *int
	ClaimsVersion  int
	CreatedAt      time.Time
}

// HasMediaFacts guards the kind-determined fact set before persistence:
// images carry dimensions plus pixel count and never a duration, audio
// carries only a duration, video carries dimensions plus duration. The
// database CHECK is the durable twin of this rule.
func (m *ReferenceMaterial) HasMediaFacts() bool {
	switch m.Kind {
	case KindImage:
		return m.WidthPx != nil && m.HeightPx != nil && m.PixelCount != nil && m.DurationMS == nil
	case KindVideo:
		return m.WidthPx != nil && m.HeightPx != nil && m.DurationMS != nil && m.PixelCount == nil
	case KindAudio:
		return m.WidthPx == nil && m.HeightPx == nil && m.PixelCount == nil && m.DurationMS != nil
	default:
		return false
	}
}
