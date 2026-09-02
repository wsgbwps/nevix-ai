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

// Structural draft envelope (contracts/creation.yaml SessionDraftInput). The
// bounds here are deliberately wider than any single manifest version: values
// the current manifest has removed must round-trip untouched so a stale draft
// is preserved, never silently rewritten; manifest conformance belongs to
// submission time.
const (
	DraftPromptMaxChars = 2000
	DraftModelMaxChars  = 128
	DraftModeMaxChars   = 64
	DraftValueMaxChars  = 16
	// The widest reference ceiling any manifest version may publish: the
	// base image model's 14 (manifest v5). Per-model conformance belongs to
	// submission time.
	DraftMaxReferenceFrames = 14
)

// DraftReference is one ordered material binding of the draft; slice order in
// SessionDraft.References is the pile order persisted as position.
type DraftReference struct {
	MaterialID UUID
	Role       DraftRole
}

// SessionDraft is the recoverable generation intent of a session: prompt,
// target media, the manifest version the composer rendered when saving, the
// model/mode/parameters as chosen, and the ordered reference bindings.
// Nil pointers mean the field is unset, not empty — an unset value and a
// stored zero are different draft facts. Revision is the draft's last save
// timestamp (zero on a never-saved draft); admission compares it against the
// submitter's draft_revision to reject stale submissions.
type SessionDraft struct {
	Revision        time.Time
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

// Validate enforces the structural draft envelope. It never consults the
// capability manifest: stale-but-wellformed values stay preserved.
func (d *SessionDraft) Validate() error {
	if utf8.RuneCountInString(d.Prompt) > DraftPromptMaxChars {
		return ErrInvalidDraft
	}
	if d.MediaType != nil && *d.MediaType != DraftMediaImage && *d.MediaType != DraftMediaVideo {
		return ErrInvalidDraft
	}
	if d.ManifestVersion < 1 {
		return ErrInvalidDraft
	}
	// Each field checks against its own named bound — never via pointer
	// identity — so aliased pointers cannot swap one field's limit for
	// another's and turn a 400 into a database-check 500.
	if overLimit(d.Model, DraftModelMaxChars) || overLimit(d.Mode, DraftModeMaxChars) ||
		overLimit(d.Ratio, DraftValueMaxChars) || overLimit(d.Resolution, DraftValueMaxChars) {
		return ErrInvalidDraft
	}
	if d.Quantity != nil && (*d.Quantity < 1 || *d.Quantity > 4) {
		return ErrInvalidDraft
	}
	if d.DurationSeconds != nil && *d.DurationSeconds < 1 {
		return ErrInvalidDraft
	}
	if len(d.References) > DraftMaxReferenceFrames {
		return ErrInvalidDraft
	}
	for _, reference := range d.References {
		switch reference.Role {
		case RoleReference, RoleFirstFrame, RoleLastFrame, RoleOmni:
		default:
			return ErrInvalidDraft
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
