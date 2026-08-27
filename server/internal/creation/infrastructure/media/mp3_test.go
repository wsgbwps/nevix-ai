package media

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// mp3Frame builds one MPEG1 Layer III frame: 4-byte header plus synthetic
// payload sized to the CBR formula, optionally carrying an Xing/Info count.
func mp3Frame(bitrateIdx byte, withXing bool, frames uint32) []byte {
	header := []byte{0xFF, 0xFB, bitrateIdx << 4, 0x00} // MPEG1 L3 44100 no-CRC
	bitrate := mp3BitratesV1L3[bitrateIdx]
	frameLen := 144 * bitrate * 1000 / 44100
	payload := make([]byte, frameLen-4)
	if withXing {
		count := make([]byte, 16)
		copy(count[0:4], "Xing")
		binary.BigEndian.PutUint32(count[4:8], 0x00000001) // frames flag
		binary.BigEndian.PutUint32(count[8:12], frames)
		copy(payload[8:], count) // just past header + side info region in spirit
	}
	return append(header, payload...)
}

func TestIdentifyMP3WithXingFrameCount(t *testing.T) {
	frames := uint32(200)
	// A real Xing file continues with ordinary frames after the info frame.
	blob := mp3ConcatFrames(
		mp3Frame(9 /*128kbps*/, true, frames),
		mp3Frame(9, false, 0),
		mp3Frame(9, false, 0),
	)
	got, err := Identify(bytes.NewReader(blob))
	if err != nil {
		t.Fatalf("identify: %v", err)
	}
	if got.Kind != domain.KindAudio || got.Facts.MimeType != "audio/mpeg" {
		t.Fatalf("kind=%q mime=%q", got.Kind, got.Facts.MimeType)
	}
	want := int(uint64(frames) * 1152 * 1000 / 44100)
	if got.Facts.DurationMS == nil || *got.Facts.DurationMS != want {
		t.Fatalf("duration %v want %dms", got.Facts.DurationMS, want)
	}
}

func TestIdentifyMP3CBRFallbackWithoutXing(t *testing.T) {
	frameLen := 144 * 128 * 1000 / 44100 // 417 bytes at 128 kbps
	blob := bytes.Repeat(mp3Frame(9, false, 0), 300)
	_ = frameLen
	got, err := Identify(bytes.NewReader(blob))
	if err != nil {
		t.Fatalf("identify: %v", err)
	}
	want := int(int64(len(blob)) * 8 / int64(128)) // ms via audioBytes*8/bitrateKbps
	if got.Facts.DurationMS == nil || *got.Facts.DurationMS != want {
		t.Fatalf("duration %v want ~%dms", got.Facts.DurationMS, want)
	}
}

func TestIdentifyMP3RejectsNonAudioGarbage(t *testing.T) {
	if _, err := Identify(bytes.NewReader([]byte{0xFF, 0xFB})); err == nil {
		t.Fatal("truncated sync must fail")
	}
	// One plausible header followed by arbitrary bytes is not an MP3:
	// frame continuity is part of authoritative readability (AC #156).
	lone := append(mp3Frame(9, false, 0), bytes.Repeat([]byte{0xAB}, 4096)...)
	if _, err := Identify(bytes.NewReader(lone)); err == nil {
		t.Fatal("isolated header plus garbage must fail")
	}
}

func mp3ConcatFrames(frames ...[]byte) []byte {
	var buf bytes.Buffer
	for _, f := range frames {
		buf.Write(f)
	}
	return buf.Bytes()
}
