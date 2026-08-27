// Package media performs the Server-authoritative verification that decides
// whether an uploaded reference material may exist at all: content sniffing,
// structural identification, real decoding, and derivation of dimensions,
// pixel counts, and durations. Client-side checks are convenience only;
// these probes are the enforcement point (issue #156).
//
// All parsers are hand-written and bounded on purpose: they read box/frame
// headers instead of buffering media bodies, keep the dependency surface
// minimal (only golang.org/x/image for WebP decoding), and return the
// domain taxonomy rather than transport-shaped errors.
package media

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// Family is the coarse content class established by inspecting leading
// bytes alone. It drives fail-fast rejection and per-family size ceilings
// before any body is stored.
type Family int

const (
	FamilyUnknown Family = iota
	FamilyJPEG
	FamilyPNG
	FamilyWebP
	FamilyMP4
	FamilyMP3
	FamilyWAV
)

// Sniff inspects a bounded lead slice; more than 16 bytes is never needed.
func Sniff(head []byte) Family {
	switch {
	case len(head) >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF:
		return FamilyJPEG
	case len(head) >= 8 && bytes.Equal(head[0:8], []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}):
		return FamilyPNG
	case len(head) >= 12 && bytes.Equal(head[0:4], []byte("RIFF")) && bytes.Equal(head[8:12], []byte("WEBP")):
		return FamilyWebP
	case len(head) >= 12 && bytes.Equal(head[8:12], []byte("WEBP")):
		return FamilyWebP
	case len(head) >= 8 && bytes.Equal(head[4:8], []byte("ftyp")):
		return FamilyMP4
	case len(head) >= 12 && bytes.Equal(head[0:4], []byte("RIFF")) && bytes.Equal(head[8:12], []byte("WAVE")):
		return FamilyWAV
	case len(head) >= 3 && bytes.Equal(head[0:3], []byte("ID3")):
		return FamilyMP3
	case len(head) >= 2 && head[0] == 0xFF && head[1]&0xE0 == 0xE0:
		return FamilyMP3
	default:
		return FamilyUnknown
	}
}

// Kind maps a family onto the coarse kind that selects its ingestion
// ceiling. An MP4 container stays under the video ceiling until deeper
// probing resolves it into pure audio.
func (f Family) Kind() domain.Kind {
	switch f {
	case FamilyJPEG, FamilyPNG, FamilyWebP:
		return domain.KindImage
	case FamilyMP4:
		return domain.KindVideo
	case FamilyMP3, FamilyWAV:
		return domain.KindAudio
	default:
		return ""
	}
}

// Prober adapts the package's authoritative probing onto the domain port.
type Prober struct{}

// IngestCeiling satisfies domain.MediaProber: the sniffed family picks the
// streaming ceiling that applies before the authoritative kind is known.
func (Prober) IngestCeiling(head []byte) (int64, bool) {
	kind := Sniff(head).Kind()
	if kind == "" {
		return 0, false
	}
	return kind.SizeLimit(), true
}

// Identify satisfies domain.MediaProber.
func (Prober) Identify(seek domain.ReadSeekCloser) (domain.Identified, error) {
	return Identify(seek)
}

// ErrProbe short-circuits identify paths whose failure reason is one of the
// domain sentinels already; wrapping keeps the chain intact.
var errShortRead = errors.New("truncated media structure")

// Identify opens authoritative probing over a seekable window covering the
// blob (callers normally pass the full range). The seeker's final position
// is unspecified; each call opens its own window.
func Identify(seek io.ReadSeeker) (domain.Identified, error) {
	head := make([]byte, 512)
	n, _ := readHead(seek, head)
	if n == 0 {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	switch family := Sniff(head[:n]); family {
	case FamilyJPEG:
		return identifyImage(family, seek)
	case FamilyPNG:
		return identifyImage(family, seek)
	case FamilyWebP:
		return identifyImage(family, seek)
	case FamilyMP4:
		return identifyMP4(seek)
	case FamilyMP3:
		return identifyMP3(seek)
	case FamilyWAV:
		return identifyWAV(seek)
	default:
		return domain.Identified{}, domain.ErrUnsupportedMedia
	}
}

// readHead pulls up to len(dst) leading bytes without assuming seekability
// beyond repositioning to zero first.
func readHead(seek io.ReadSeeker, dst []byte) (int, error) {
	if _, err := seek.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	return io.ReadFull(seek, dst[:cap(dst)])
}

// readExact scans exactly n bytes at the current position.
func readExact(r io.Reader, n int64) ([]byte, error) {
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, errShortRead
	}
	return buf, nil
}

// beUint32 decodes a big-endian box field; a single helper keeps every parser
// on identical endianness discipline.
func beUint32(b []byte) uint32 { return binary.BigEndian.Uint32(b) }

func intPtr(v int) *int     { return &v }
func i64Ptr(v int64) *int64 { return &v }
