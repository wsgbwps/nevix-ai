package media

import (
	"encoding/binary"
	"fmt"
	"io"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// ISO base media file constants used by the walker.
const (
	boxHeaderLen   = 8
	boxHeaderLarge = 16
)

// mp4Track accumulates what one trak declares about itself.
type mp4Track struct {
	handler  string // 'vide' | 'soun' | other
	format   string // first sample description format, e.g. avc1 / mp4a
	widthPx  int
	heightPx int
}

// identifyMP4 walks the container's box tree with header-sized reads only:
// large mdat payloads are jumped over, so probing cost never scales with
// media length even when moov sits at the tail of a non-faststart recording.
func identifyMP4(seek io.ReadSeeker) (domain.Identified, error) {
	total, err := seek.Seek(0, io.SeekEnd)
	if err != nil || total < boxHeaderLen {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	moov, ok, err := findBox(seek, 0, total, "moov")
	if err != nil {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	if !ok {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}

	var tracks []mp4Track
	timescale := uint32(0)
	duration := uint64(0)
	fragmented := false

	err = walkBoxes(seek, moov.start+boxHeaderLen, moov.contentEnd(), func(child boxRef, r io.Reader) error {
		switch child.ftype {
		case "mvhd":
			ts, dur, err := parseMVHD(r)
			if err != nil {
				return err
			}
			timescale, duration = ts, dur
		case "trak":
			track, err := parseTrak(seek, child)
			if err == nil {
				tracks = append(tracks, track)
			}
		case "mvex":
			fragmented = true
		}
		return nil
	})
	if err != nil {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	if timescale == 0 {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	// Authoritative duration requires a non-zero mvhd figure; a fragmented
	// movie whose totals were omitted cannot yield one without guessing.
	if fragmented && duration == 0 {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	durationMS := int(duration * 1000 / uint64(timescale))
	if durationMS <= 0 {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}

	video, audio := classifyTracks(tracks)
	switch {
	case video != nil:
		if video.format != "avc1" && video.format != "avc3" {
			// The V1 contract admits H.264 in MP4 only; HEVC/AV1 input stays
			// a stable rejection rather than a silent downgrade.
			return domain.Identified{}, domain.ErrUnsupportedMedia
		}
		width := video.widthPx
		height := video.heightPx
		if width <= 0 || height <= 0 {
			return domain.Identified{}, domain.ErrUnreadableMedia
		}
		// Pixel count is an image-only fact in the domain contract (video
		// rows must carry NULL pixel_count); dimensions and duration are the
		// video facts.
		return domain.Identified{
			Kind: domain.KindVideo,
			Facts: domain.MediaFacts{
				MimeType:   "video/mp4",
				WidthPx:    intPtr(width),
				HeightPx:   intPtr(height),
				DurationMS: intPtr(durationMS),
			},
		}, nil
	case audio != nil:
		if audio.format != "mp4a" {
			return domain.Identified{}, domain.ErrUnsupportedMedia
		}
		return domain.Identified{
			Kind: domain.KindAudio,
			Facts: domain.MediaFacts{
				MimeType:   "audio/mp4",
				DurationMS: intPtr(durationMS),
			},
		}, nil
	default:
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
}

func classifyTracks(tracks []mp4Track) (*mp4Track, *mp4Track) {
	var video, audio *mp4Track
	for index := range tracks {
		switch tracks[index].handler {
		case "vide":
			if video == nil {
				video = &tracks[index]
			}
		case "soun":
			if audio == nil {
				audio = &tracks[index]
			}
		}
	}
	return video, audio
}

// boxRef locates one parsed box inside the stream.
type boxRef struct {
	ftype string
	start int64 // offset of the box header
	size  int64 // full box length including header
}

func (b boxRef) contentEnd() int64 { return b.start + b.size }

// findBox scans sibling boxes in [from,to) for one type.
func findBox(seek io.ReadSeeker, from, to int64, want string) (boxRef, bool, error) {
	var found boxRef
	err := walkBoxes(seek, from, to, func(box boxRef, _ io.Reader) error {
		if box.ftype == want {
			found = box
			return errStopWalk
		}
		return nil
	})
	if err != nil && err != errStopWalk {
		return found, false, err
	}
	return found, found.ftype == want, nil
}

var errStopWalk = fmt.Errorf("stop box walk")

// walkBoxes iterates direct children in [contentFrom,contentTo), invoking fn
// with an unbounded reader positioned at each child's content. It trusts
// declared sizes structurally but refuses zero-progress steps and runaway
// chains, which keeps hostile containers bounded.
func walkBoxes(seek io.ReadSeeker, contentFrom, contentTo int64, fn func(boxRef, io.Reader) error) error {
	pos := contentFrom
	const maxBoxes = 4096
	for i := 0; pos+boxHeaderLen <= contentTo && i < maxBoxes; i++ {
		header := make([]byte, boxHeaderLen)
		if _, err := readAtOffset(seek, header, pos); err != nil {
			return err
		}
		size := int64(beUint32(header[:4]))
		ftype := string(header[4:8])
		headerLen := int64(boxHeaderLen)
		if size == 1 {
			large := make([]byte, 8)
			if _, err := readAtOffset(seek, large, pos+boxHeaderLen); err != nil {
				return err
			}
			size = int64(binary.BigEndian.Uint64(large))
			headerLen = boxHeaderLarge
		} else if size == 0 {
			size = contentTo - pos // extends to the enclosing box's end
		}
		if size < headerLen || pos+size > contentTo {
			return fmt.Errorf("degenerate box %q at %d", ftype, pos)
		}
		if _, err := seek.Seek(pos+headerLen, io.SeekStart); err != nil {
			return err
		}
		child := boxRef{ftype: ftype, start: pos, size: size}
		reader := io.Reader(newBoundedReader(seek, child.contentEnd()))
		if err := fn(child, reader); err != nil {
			return err
		}
		pos += size
	}
	return nil
}

// boundedReader caps reads at the box boundary so nested parsers cannot run
// into their siblings' bytes.
type boundedReader struct {
	seek io.ReadSeeker
	stop int64
}

func newBoundedReader(seek io.ReadSeeker, stop int64) *boundedReader {
	return &boundedReader{seek: seek, stop: stop}
}

func (b *boundedReader) Read(p []byte) (int, error) {
	current, err := b.seek.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, err
	}
	remaining := b.stop - current
	if remaining <= 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > remaining {
		p = p[:remaining]
	}
	return b.seek.Read(p)
}

func readAtOffset(seek io.ReadSeeker, dst []byte, offset int64) (int, error) {
	if _, err := seek.Seek(offset, io.SeekStart); err != nil {
		return 0, err
	}
	return io.ReadFull(seek, dst)
}

// parseMVHD reads the movie header: timescale plus total duration, handling
// both version layouts.
func parseMVHD(r io.Reader) (uint32, uint64, error) {
	head, err := readExact(r, 4) // version + flags
	if err != nil {
		return 0, 0, err
	}
	switch head[0] {
	case 1:
		body, err := readExact(r, 28) // creation(8)+modification(8)+timescale(4)+duration(8)
		if err != nil {
			return 0, 0, err
		}
		return binary.BigEndian.Uint32(body[16:20]), binary.BigEndian.Uint64(body[20:28]), nil
	default:
		body, err := readExact(r, 16) // creation(4)+modification(4)+timescale(4)+duration(4)
		if err != nil {
			return 0, 0, err
		}
		return binary.BigEndian.Uint32(body[8:12]), uint64(binary.BigEndian.Uint32(body[12:16])), nil
	}
}

// parseTrak digs out handler type and the leading sample description's
// format (+visual dimensions when present). Any parse hiccup yields a zero
// track that classification simply ignores.
func parseTrak(seek io.ReadSeeker, trak boxRef) (mp4Track, error) {
	track := mp4Track{}
	mdia, ok, err := findBoxInBox(seek, trak, "mdia")
	if err != nil || !ok {
		return track, errSkipTrack
	}
	hdlr, ok, err := findBoxInBox(seek, mdia, "hdlr")
	if err != nil || !ok {
		return track, errSkipTrack
	}
	content := make([]byte, hdlr.size-boxHeaderLen)
	if _, err := readAtOffset(seek, content, hdlr.start+boxHeaderLen); err != nil {
		return track, errSkipTrack
	}
	if len(content) >= 12 {
		track.handler = string(content[8:12])
	}

	stbl, ok, err := findBoxInPath(seek, mdia, "minf", "stbl")
	if err != nil || !ok {
		return track, errSkipTrack
	}
	stsd, ok, err := findBoxInBox(seek, stbl, "stsd")
	if err != nil || !ok {
		return track, errSkipTrack
	}
	entry := make([]byte, min64(stsd.size-boxHeaderLen, 256))
	if len(entry) < 16 {
		return track, errSkipTrack
	}
	if _, err := readAtOffset(seek, entry, stsd.start+boxHeaderLen); err != nil {
		return track, errSkipTrack
	}
	track.format = string(entry[12:16])
	if track.format == "avc1" || track.format == "avc3" {
		if len(entry) >= 44 {
			track.widthPx = int(binary.BigEndian.Uint16(entry[40:42]))
			track.heightPx = int(binary.BigEndian.Uint16(entry[42:44]))
		}
	}
	return track, nil
}

var errSkipTrack = fmt.Errorf("skip partially parsed track")

// findBoxInBox scans direct children of one already-located box.
func findBoxInBox(seek io.ReadSeeker, parent boxRef, want string) (boxRef, bool, error) {
	return findBox(seek, parent.start+boxHeaderLen, parent.contentEnd(), want)
}

// findBoxInPath descends two named levels (minf/stbl style).
func findBoxInPath(seek io.ReadSeeker, parent boxRef, middle, leaf string) (boxRef, bool, error) {
	mid, ok, err := findBoxInBox(seek, parent, middle)
	if err != nil || !ok {
		return boxRef{}, false, err
	}
	return findBoxInBox(seek, mid, leaf)
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
