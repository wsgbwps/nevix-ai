package media

import (
	"encoding/binary"
	"io"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// MPEG audio constants for the Layer III profiles V1 accepts.
const (
	mp3MaxHeaderProbe = 1 << 20 // bounded sync search window
	samplesPerFrameV1 = 1152
	samplesPerFrameV2 = 576
)

// mp3FrameInfo is one parsed frame header.
type mp3FrameInfo struct {
	versionBits uint8 // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
	bitrateKbps int
	sampleRate  int
	padding     bool
	protected   bool // CRC-16 word follows the header when set
}

// identifyMP3 establishes duration by counting frames when a Xing/Info tag
// declares them, else falling back to the CBR estimate from file length.
// The scanner stays bounded: it walks headers through a small window at the
// start rather than streaming the whole body. Authoritative readability
// requires frame continuity — one plausible header followed by arbitrary
// bytes is not an MP3 — so the first header must chain into consecutive
// frames at their computed stride (AC #156): a Xing/Info frame count plus
// one chained frame, or three consecutive CBR frames.
func identifyMP3(seek io.ReadSeeker) (domain.Identified, error) {
	head := make([]byte, mp3MaxHeaderProbe)
	n, err := readAtOffset(seek, head, 0)
	if err != nil && n == 0 {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	audioStart := skipID3v2(head[:n])
	offset := findSyncWindow(head[:n], audioStart)
	if offset < 0 {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	info, ok := parseMP3Header(head[offset:], n-offset)
	if !ok {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	frameBodyFrom := offset + 4 // header; +CRC(2) below when protected
	if info.protected {
		frameBodyFrom += 2
	}

	chain := consecutiveFrameCount(head[:n], offset, info)
	durationMS := xingDuration(head[:n], frameBodyFrom, info)
	hasXingCount := durationMS > 0
	if chain < mp3MinConsecutiveFrames && !(hasXingCount && chain >= 2) {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}

	total := int64(0)
	if end, seekErr := seek.Seek(0, io.SeekEnd); seekErr == nil {
		total = end
	}
	if !hasXingCount && total > 0 {
		audioBytes := total - int64(offset)
		if audioBytes <= 0 {
			return domain.Identified{}, domain.ErrUnreadableMedia
		}
		durationMS = int(audioBytes * 8 * 1000 / int64(info.bitrateKbps) / 1000)
	}
	if durationMS <= 0 {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	return domain.Identified{
		Kind: domain.KindAudio,
		Facts: domain.MediaFacts{
			MimeType:   "audio/mpeg",
			DurationMS: intPtr(durationMS),
		},
	}, nil
}

// mp3MinConsecutiveFrames is the CBR continuity bar: the first header plus
// two chained frames at their computed stride.
const mp3MinConsecutiveFrames = 3

// consecutiveFrameCount strides frame-to-frame from the first header,
// re-deriving each stride from the header it lands on (VBR files vary
// bitrate per frame), and stops at the first break or the bar.
func consecutiveFrameCount(buf []byte, from int, info mp3FrameInfo) int {
	count := 1
	pos := from
	stride := frameStrideBytes(info)
	for count < mp3MinConsecutiveFrames {
		next := pos + stride
		if next+4 > len(buf) {
			break
		}
		nextInfo, ok := parseMP3Header(buf[next:], len(buf)-next)
		if !ok {
			break
		}
		count++
		pos = next
		stride = frameStrideBytes(nextInfo)
	}
	return count
}

// frameStrideBytes is one Layer III frame's byte length for its header:
// floor(samplesPerFrame * bitrate / (8 * sampleRate)) + padding.
func frameStrideBytes(info mp3FrameInfo) int {
	samples := samplesPerFrameV1
	if info.versionBits != 0x03 {
		samples = samplesPerFrameV2
	}
	pad := 0
	if info.padding {
		pad = 1
	}
	return int(uint64(samples)*uint64(info.bitrateKbps)*125/uint64(info.sampleRate)) + pad
}

// skipID3v2 consumes a leading ID3v2 tag using its synchsafe size.
func skipID3v2(buf []byte) int {
	if len(buf) >= 10 && string(buf[0:3]) == "ID3" {
		size := int(buf[6]&0x7F)<<21 | int(buf[7]&0x7F)<<14 | int(buf[8]&0x7F)<<7 | int(buf[9]&0x7F)
		tagEnd := 10 + size
		if tagEnd < len(buf) {
			return tagEnd
		}
	}
	return 0
}

// findSyncWindow locates the first plausible frame-header offset after from;
// plausibility gets fully re-checked by parseMP3Header.
func findSyncWindow(buf []byte, from int) int {
	for i := from; i+4 <= len(buf); i++ {
		if buf[i] == 0xFF && buf[i+1]&0xE0 == 0xE0 {
			if _, ok := parseMP3Header(buf[i:], len(buf)-i); ok {
				return i
			}
		}
	}
	return -1
}

var mp3BitratesV1L3 = [16]int{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0}
var mp3BitratesV2L3 = [16]int{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0}
var mp3SampleRatesV1 = [4]int{44100, 48000, 32000, 0}
var mp3SampleRatesV2 = [4]int{22050, 24000, 16000, 0} // includes MPEG2; 2.5 handled below
var mp3SampleRates25 = [4]int{11025, 12000, 8000, 0}

func parseMP3Header(b []byte, avail int) (mp3FrameInfo, bool) {
	if avail < 4 || b[0] != 0xFF {
		return mp3FrameInfo{}, false
	}
	versionBits := (b[1] >> 3) & 0x03
	layerBits := (b[1] >> 1) & 0x03
	if layerBits != 0x01 { // only Layer III: encoding '01'
		return mp3FrameInfo{}, false
	}
	bitrateIdx := b[2] >> 4
	rateIdx := (b[2] >> 2) & 0x03
	if bitrateIdx == 15 || bitrateIdx == 0 || rateIdx == 3 {
		return mp3FrameInfo{}, false
	}
	info := mp3FrameInfo{versionBits: versionBits, padding: b[2]&0x02 != 0, protected: b[1]&0x01 == 0}
	switch versionBits {
	case 0x03: // MPEG 1
		info.bitrateKbps = mp3BitratesV1L3[bitrateIdx]
		switch rateIdx {
		case 0:
			info.sampleRate = mp3SampleRatesV1[0]
		case 1:
			info.sampleRate = mp3SampleRatesV1[1]
		case 2:
			info.sampleRate = mp3SampleRatesV1[2]
		default:
			return mp3FrameInfo{}, false
		}
	case 0x02, 0x00: // MPEG 2 / 2.5
		if versionBits == 0x02 {
			info.bitrateKbps = mp3BitratesV2L3[bitrateIdx]
			info.sampleRate = mp3SampleRatesV2[rateIdx]
		} else {
			info.bitrateKbps = mp3BitratesV2L3[bitrateIdx]
			info.sampleRate = mp3SampleRates25[rateIdx]
		}
		if info.sampleRate == 0 {
			return mp3FrameInfo{}, false
		}
	default:
		return mp3FrameInfo{}, false
	}
	if info.bitrateKbps == 0 || info.sampleRate == 0 {
		return mp3FrameInfo{}, false
	}
	return info, true
}

// xingDuration reads an Xing/Info frame-count when present near the first
// frame's payload and returns the exact duration in milliseconds. VBRI tags
// are deliberately unsupported: they are rare and the CBR fallback covers
// them within ingest tolerance.
func xingDuration(buf []byte, frameBodyFrom int, info mp3FrameInfo) int {
	limit := frameBodyFrom + 256
	if limit > len(buf) {
		limit = len(buf)
	}
	for i := frameBodyFrom; i+16 <= limit; i++ {
		tag := string(buf[i : i+4])
		if tag != "Xing" && tag != "Info" {
			continue
		}
		flags := binary.BigEndian.Uint32(buf[i+4 : i+8])
		const framesFlag = 0x00000001
		if flags&framesFlag == 0 {
			return 0
		}
		frames := binary.BigEndian.Uint32(buf[i+8 : i+12])
		samples := samplesPerFrameV1
		if info.versionBits != 0x03 {
			samples = samplesPerFrameV2
		}
		return int(uint64(frames) * uint64(samples) * 1000 / uint64(info.sampleRate))
	}
	return 0
}
