package integrationtest

import (
	"bytes"
	"testing"

	"github.com/nevix-ai/server/internal/creation/infrastructure/media"
)

type seekCloser struct {
	*bytes.Reader
}

func (s seekCloser) Close() error { return nil }

// TestMp4FixtureProbes pins the synthetic video fixture to the authoritative
// probe: the fake Kapon outputs must stay decodable by the same verifier the
// transfer path uses.
func TestMp4FixtureProbes(t *testing.T) {
	identified, err := media.Prober{}.Identify(seekCloser{bytes.NewReader(mp4Fixture())})
	if err != nil {
		t.Fatalf("fixture mp4 must probe: %v", err)
	}
	if identified.Kind != "video" || identified.Facts.DurationMS == nil || *identified.Facts.DurationMS != 5000 {
		t.Fatalf("unexpected probe: %+v", identified)
	}
}
