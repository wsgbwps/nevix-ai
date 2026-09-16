package media

import (
	"bytes"
	"os"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func TestIdentifyMP4ValidatesActualAudioTrack(t *testing.T) {
	blob, err := os.ReadFile("../../../../../scripts/dev/fixtures/video-with-audio.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(blob, []byte("soun")) {
		t.Fatal("fixture must contain a real sound track")
	}
	got, err := Identify(bytes.NewReader(blob))
	if err != nil || got.Kind != domain.KindVideo || got.Facts.MimeType != "video/mp4" ||
		got.Facts.WidthPx == nil || *got.Facts.WidthPx != 320 || got.Facts.HeightPx == nil ||
		*got.Facts.HeightPx != 180 || got.Facts.DurationMS == nil || *got.Facts.DurationMS != 5000 {
		t.Fatalf("audio-bearing video facts: %+v error=%v", got, err)
	}
	broken := bytes.Clone(blob)
	for _, box := range []string{"soun", "mp4a"} {
		if !bytes.Contains(broken, []byte(box)) {
			t.Fatalf("fixture missing %s", box)
		}
	}
	// A missing sample description must not be mistaken for a silent video.
	copy(broken[bytes.Index(broken, []byte("mp4a"))-4:], []byte{0, 0, 0, 0})
	if _, err := Identify(bytes.NewReader(broken)); err != domain.ErrUnreadableMedia {
		t.Fatalf("invalid audio track must reject output, error=%v", err)
	}
}
