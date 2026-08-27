package media

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// wavBytes assembles a RIFF WAVE blob from raw chunk payloads.
func wavBytes(sampleRate uint32, bitsPerSample uint16, pcmLen uint32) []byte {
	fmtChunk := make([]byte, 16)
	binary.LittleEndian.PutUint16(fmtChunk[0:2], 1) // PCM
	binary.LittleEndian.PutUint16(fmtChunk[2:4], 1) // mono
	binary.LittleEndian.PutUint32(fmtChunk[4:8], sampleRate)
	align := bitsPerSample / 8
	binary.LittleEndian.PutUint32(fmtChunk[8:12], sampleRate*uint32(align)) // byte rate
	binary.LittleEndian.PutUint16(fmtChunk[12:14], align)
	binary.LittleEndian.PutUint16(fmtChunk[14:16], bitsPerSample)

	dataChunk := make([]byte, 8+pcmLen)
	copy(dataChunk[0:4], "data")
	binary.LittleEndian.PutUint32(dataChunk[4:8], pcmLen)

	body := mp4Concat([]byte("WAVE"), mp4BoxLE("fmt ", fmtChunk), dataChunk)
	riff := make([]byte, 8+len(body))
	copy(riff[0:4], "RIFF")
	binary.LittleEndian.PutUint32(riff[4:8], uint32(len(body)))
	copy(riff[8:], body)
	return riff
}

// mp4BoxLE mirrors mp4Box with little-endian sizes (RIFF convention).
func mp4BoxLE(chunkType string, payload []byte) []byte {
	out := make([]byte, 8+len(payload))
	copy(out[0:4], chunkType)
	binary.LittleEndian.PutUint32(out[4:8], uint32(len(payload)))
	copy(out[8:], payload)
	return out
}

func TestIdentifyWAVDuration(t *testing.T) {
	cases := []struct {
		name       string
		sampleRate uint32
		bits       uint16
		pcmLen     uint32
		wantMS     int
	}{
		{"cd-quality", 44100, 16, 44100 * 2 * 3, 3000},
		{"half-rate", 22050, 16, 22050 * 2 / 10, 100},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Identify(bytes.NewReader(wavBytes(tc.sampleRate, tc.bits, tc.pcmLen)))
			if err != nil {
				t.Fatalf("identify: %v", err)
			}
			if got.Kind != domain.KindAudio || got.Facts.MimeType != "audio/x-wav" {
				t.Fatalf("kind=%q mime=%q", got.Kind, got.Facts.MimeType)
			}
			if got.Facts.DurationMS == nil || *got.Facts.DurationMS != tc.wantMS {
				t.Fatalf("duration %v want %dms", got.Facts.DurationMS, tc.wantMS)
			}
			if got.Facts.WidthPx != nil || got.Facts.HeightPx != nil {
				t.Fatal("audio must not carry dimensions")
			}
		})
	}
}

func TestIdentifyWAVRejectsNonPCM(t *testing.T) {
	blob := wavBytes(44100, 16, 4096)
	blob[20] = 6 // audioFormat lives at riff(12) + chunk header(8); 6 = A-law
	if _, err := Identify(bytes.NewReader(blob)); err != domain.ErrUnsupportedMedia {
		t.Fatalf("err=%v want ErrUnsupportedMedia", err)
	}
}
