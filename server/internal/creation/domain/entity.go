package domain

import "time"

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
