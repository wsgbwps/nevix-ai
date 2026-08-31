package domain

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"
)

// Kind is the verified media family of a reference material. The database
// CHECK constraint mirrors this closed set.
type Kind string

const (
	KindImage Kind = "image"
	KindVideo Kind = "video"
	KindAudio Kind = "audio"
)

// ClaimsVersion marks which rights-confirmation wording the uploading action
// recorded. The upgrade rule is forward-only: raising the constant affects
// materials uploaded afterwards and never re-adjudicates existing rows, so
// older material never becomes retroactively blocked.
const ClaimsVersion = 1

// SessionNameMaxChars bounds a session name; the same bound lives in
// contracts/creation.yaml and the database check.
const SessionNameMaxChars = 128

// Size limits are the structural ingestion ceilings per kind (the wider of
// the image/video contract envelopes; generation-time envelopes belong to
// the capability-manifest slices, not to reference-material ingestion).
const (
	ImageMaxBytes int64 = 10 << 20
	AudioMaxBytes int64 = 50 << 20
	VideoMaxBytes int64 = 200 << 20
)

// SizeLimit returns the ingestion ceiling for one kind.
func (k Kind) SizeLimit() int64 {
	switch k {
	case KindImage:
		return ImageMaxBytes
	case KindAudio:
		return AudioMaxBytes
	case KindVideo:
		return VideoMaxBytes
	default:
		return 0
	}
}

// FileExtensions lists the extensions that agree with the verified family.
func (k Kind) FileExtensions() []string {
	switch k {
	case KindImage:
		return []string{".jpg", ".jpeg", ".png", ".webp"}
	case KindVideo:
		return []string{".mp4"}
	case KindAudio:
		return []string{".mp3", ".wav", ".m4a"}
	default:
		return nil
	}
}

// AcceptsExtension reports whether the declared filename extension agrees
// with the verified media family.
func (k Kind) AcceptsExtension(ext string) bool {
	ext = strings.ToLower(ext)
	for _, allowed := range k.FileExtensions() {
		if ext == allowed {
			return true
		}
	}
	return false
}

// NormalizeSessionName trims surrounding whitespace and enforces the name
// length contract. An empty result is meaningful: unnamed sessions display
// a localized fallback client-side.
func NormalizeSessionName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if len([]rune(name)) > SessionNameMaxChars {
		return "", fmt.Errorf("session name must be at most %d characters", SessionNameMaxChars)
	}
	return name, nil
}

// BlobRange is the storage seam's window primitive. A negative Length means
// "to the end of the blob"; Offset always counts from zero.
type BlobRange struct {
	Offset int64
	Length int64
}

// FullBlobRange opens a blob from byte zero to its end.
var FullBlobRange = BlobRange{Offset: 0, Length: -1}

// PutResult carries what one bounded streaming put established about the
// stored bytes: the authoritative size and the SHA-256 digest computed while
// streaming, so callers never re-read a blob to learn them.
type PutResult struct {
	ByteSize  int64
	SHA256Sum [32]byte
}

// ReadSeekCloser is what a stored blob reads back as. Seekable production
// adapters are a hard requirement: MP4 probing reads box headers near both
// ends of large files without buffering them whole.
type ReadSeekCloser interface {
	io.ReadCloser
	io.Seeker
}

// BlobStore is the storage port every reference-material blob passes through.
// Implementations stream with bounded buffers, honor context cancellation,
// and return ErrTooLarge when a Put exceeds maxBytes. Metadata lives only in
// PostgreSQL; blob backends never become business concepts (ADR-0016).
type BlobStore interface {
	// Put streams src into key with a bounded copy loop. Partial or failed
	// puts leave no usable object: implementations clean their own staging.
	Put(ctx context.Context, key string, src io.Reader, maxBytes int64) (PutResult, error)
	// Open returns a seekable reader over the requested window plus the
	// whole-blob byte size (windows may be shorter than the blob).
	Open(ctx context.Context, key string, rng BlobRange) (ReadSeekCloser, int64, error)
	// Delete removes the blob. Deleting an absent key succeeds: cleanup paths
	// are best-effort by contract.
	Delete(ctx context.Context, key string) error
}

// MediaFacts are the authoritative observations one probe established for a
// stored blob: canonical MIME, dimensions, pixel count, duration.
type MediaFacts struct {
	MimeType   string
	WidthPx    *int
	HeightPx   *int
	PixelCount *int64
	DurationMS *int
}

// Identified carries the authoritative probe verdict for one stored blob.
type Identified struct {
	Kind  Kind
	Facts MediaFacts
}

// MediaProber is the authoritative probing port: implementations fully
// decode or structure-walk one stored blob to establish kind and facts.
// Application consumes the port; infrastructure provides the parsers.
type MediaProber interface {
	// IngestCeiling reports the byte ceiling to stream this content family
	// under before its authoritative kind is known; ok=false rejects the
	// lead bytes as unsupported before any storage write.
	IngestCeiling(head []byte) (ceiling int64, ok bool)
	Identify(seek ReadSeekCloser) (Identified, error)
}

// ReferenceBlobKey derives the stable blob-store object key for one new
// material identity — the single place where a material id becomes a
// Storage address. Both blob adapters and the ingest use-case share it so
// key shape can never drift between placement and retrieval.
func ReferenceBlobKey(id UUID) string {
	hexed := id.String()
	return "reference-materials/" + hexed[0:2] + "/" + hexed[2:4] + "/" + hexed
}

// Time aliases time.Time for entity signatures in this package's files.
type Time = time.Time

// GenerationResultBlobKey derives the stable blob-store object key for one
// slot's transferred output — the single place a (task, slot) pair becomes a
// Storage address, shared by transfer and download.
func GenerationResultBlobKey(taskID UUID, index int) string {
	hexed := taskID.String()
	return fmt.Sprintf("generation-results/%s/%s/%s-slot-%d", hexed[0:2], hexed[2:4], hexed, index)
}

// GenerationResultMaxBytes is the defensive per-output transfer ceiling
// (spec #150 输出持久化).
const GenerationResultMaxBytes int64 = 1 << 30
