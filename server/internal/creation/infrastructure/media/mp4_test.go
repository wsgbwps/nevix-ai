package media

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// mp4 box construction helpers: each returns a complete box (header plus
// payload) whose internal layout mirrors the fields identifyMP4 reads.

func mp4Box(ftype string, payload []byte) []byte {
	out := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint32(out[0:4], uint32(len(payload)+8))
	copy(out[4:8], ftype)
	copy(out[8:], payload)
	return out
}

func mp4Concat(parts ...[]byte) []byte {
	var buf bytes.Buffer
	for _, part := range parts {
		buf.Write(part)
	}
	return buf.Bytes()
}

// versionedFlags is the leading word of every fullBox payload.
var versionedFlags = []byte{0x00, 0x00, 0x00, 0x00}

func mvhdV0(timescale, duration uint32) []byte {
	payload := make([]byte, 96)
	copy(payload, versionedFlags)
	binary.BigEndian.PutUint32(payload[12:16], timescale) // after version+flags+creation+modification
	binary.BigEndian.PutUint32(payload[16:20], duration)
	return mp4Box("mvhd", payload)
}

func hdlr(handler string) []byte {
	payload := make([]byte, 24)
	copy(payload, versionedFlags)
	copy(payload[8:12], handler) // pre_defined(4) then handler_type
	return mp4Box("hdlr", payload)
}

func mdhdStub() []byte { return mp4Box("mdhd", make([]byte, 28)) }

func vmhdStub() []byte {
	payload := make([]byte, 16)
	copy(payload, versionedFlags)
	return mp4Box("vmhd", payload)
}

func stsdVisual(width, height uint16) []byte {
	entry := make([]byte, 36)
	binary.BigEndian.PutUint32(entry[0:4], 36)
	copy(entry[4:8], "avc1")                        // format
	binary.BigEndian.PutUint16(entry[32:34], width) // VisualSampleEntry dims
	binary.BigEndian.PutUint16(entry[34:36], height)
	payload := append(append([]byte{}, versionedFlags...), 0, 0, 0, 1) // verflags + entry_count=1
	payload = append(payload, entry...)
	return mp4Box("stsd", payload)
}

func stsdAudio() []byte {
	entry := make([]byte, 36)
	binary.BigEndian.PutUint32(entry[0:4], 36)
	copy(entry[4:8], "mp4a")
	payload := append(append([]byte{}, versionedFlags...), 0, 0, 0, 1)
	payload = append(payload, entry...)
	return mp4Box("stsd", payload)
}

// Build a complete video MP4: ftyp + moov{mvhd,trak{mdia{mdhd,hdlr,minf{
// vmhd,stbl{stsd}}}}} + empty mdat.
func videoMP4(timescale, durationMs uint32, width, height uint16) []byte {
	stbl := mp4Box("stbl", stsdVisual(width, height))
	minf := mp4Box("minf", mp4Concat(vmhdStub(), stbl))
	mdia := mp4Box("mdia", mp4Concat(mdhdStub(), hdlr("vide"), minf))
	trak := mp4Box("trak", mdia)
	moov := mp4Box("moov", mp4Concat(mvhdV0(timescale, durationMs), trak))
	ftyp := mp4Box("ftyp", []byte("isom\x00\x00\x02\x00isomiso2avc1"))
	dat := mp4Box("mdat", bytes.Repeat([]byte{0xAB}, 64))
	return mp4Concat(ftyp, moov, dat)
}

func audioOnlyMP4(timescale, durationMs uint32) []byte {
	stbl := mp4Box("stbl", stsdAudio())
	minf := mp4Box("minf", stbl)
	mdia := mp4Box("mdia", mp4Concat(mdhdStub(), hdlr("soun"), minf))
	trak := mp4Box("trak", mdia)
	moov := mp4Box("moov", mp4Concat(mvhdV0(timescale, durationMs), trak))
	ftyp := mp4Box("ftyp", []byte("M4A \x00\x00\x02\x00isomiso2"))
	return mp4Concat(ftyp, moov)
}

func hevcVideoMP4() []byte {
	// Same skeleton but the sample description names a codec outside the V1
	// allowlist.
	stbl := mp4Box("stbl", stsdVisualNamed("hev1", 1920, 1080))
	minf := mp4Box("minf", stbl)
	mdia := mp4Box("mdia", mp4Concat(hdlr("vide"), minf))
	trak := mp4Box("trak", mdia)
	moov := mp4Box("moov", mp4Concat(mvhdV0(1000, 3000), trak))
	return mp4Concat(mp4Box("ftyp", []byte("isom\x00\x00\x02\x00isomiso2")), moov)
}

func stsdVisualNamed(format string, width, height uint16) []byte {
	entry := make([]byte, 36)
	binary.BigEndian.PutUint32(entry[0:4], 36)
	copy(entry[4:8], format)
	binary.BigEndian.PutUint16(entry[32:34], width)
	binary.BigEndian.PutUint16(entry[34:36], height)
	payload := append(append([]byte{}, versionedFlags...), 0, 0, 0, 1)
	return mp4Box("stsd", append(payload, entry...))
}

func TestIdentifyMP4SyntheticVideo(t *testing.T) {
	blob := videoMP4(1000, 5000, 640, 360)
	got, err := Identify(bytes.NewReader(blob))
	if err != nil {
		t.Fatalf("identify: %v", err)
	}
	if got.Kind != domain.KindVideo {
		t.Fatalf("kind %q want video", got.Kind)
	}
	if got.Facts.MimeType != "video/mp4" || got.Facts.WidthPx == nil || *got.Facts.WidthPx != 640 ||
		got.Facts.HeightPx == nil || *got.Facts.HeightPx != 360 {
		t.Fatalf("facts %+v", got.Facts)
	}
	if got.Facts.DurationMS == nil || *got.Facts.DurationMS != 5000 {
		t.Fatalf("duration %+v want 5000ms", got.Facts.DurationMS)
	}
}

func TestIdentifyMP4AudioOnlyIsAudioKind(t *testing.T) {
	got, err := Identify(bytes.NewReader(audioOnlyMP4(1000, 12000)))
	if err != nil {
		t.Fatalf("identify: %v", err)
	}
	if got.Kind != domain.KindAudio || got.Facts.MimeType != "audio/mp4" {
		t.Fatalf("kind=%q mime=%q want audio/mp4", got.Kind, got.Facts.MimeType)
	}
	if got.Facts.DurationMS == nil || *got.Facts.DurationMS != 12000 {
		t.Fatalf("duration %+v", got.Facts.DurationMS)
	}
	if got.Facts.WidthPx != nil || got.Facts.HeightPx != nil {
		t.Fatal("audio must not carry dimensions")
	}
}

func TestIdentifyMP4RejectsNonH264Video(t *testing.T) {
	if _, err := Identify(bytes.NewReader(hevcVideoMP4())); err != domain.ErrUnsupportedMedia {
		t.Fatalf("err=%v want ErrUnsupportedMedia", err)
	}
}

func TestIdentifyMP4RejectsZeroDuration(t *testing.T) {
	blob := videoMP4(1000, 0, 640, 360)
	if _, err := Identify(bytes.NewReader(blob)); err != domain.ErrUnreadableMedia {
		t.Fatalf("err=%v want ErrUnreadableMedia for zero duration", err)
	}
}

func TestIdentifyMP4WithoutMoov(t *testing.T) {
	orphan := mp4Concat(mp4Box("ftyp", []byte("isom\x00\x00\x02\x00")), mp4Box("mdat", make([]byte, 100)))
	if _, err := Identify(bytes.NewReader(orphan)); err != domain.ErrUnreadableMedia {
		t.Fatalf("err=%v want ErrUnreadableMedia without moov", err)
	}
}
