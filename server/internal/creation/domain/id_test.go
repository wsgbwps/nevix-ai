package domain

import "testing"

func TestUUIDRoundTripAndValidation(t *testing.T) {
	original := NewUUID()
	text := original.String()
	parsed, err := ParseUUID(text)
	if err != nil || parsed != original {
		t.Fatalf("round trip %q -> %v err=%v", text, parsed, err)
	}
	for _, bad := range []string{
		"", "not-a-uuid",
		"zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
		original.String() + "-extra",
	} {
		if _, err := ParseUUID(bad); err == nil {
			t.Errorf("ParseUUID(%q) unexpectedly succeeded", bad)
		}
	}
}

func TestSessionNameNormalization(t *testing.T) {
	got, err := NormalizeSessionName("  樱花商拍  ")
	if err != nil || got != "樱花商拍" {
		t.Fatalf("normalize -> %q err=%v", got, err)
	}
	if got, _ := NormalizeSessionName("   "); got != "" {
		t.Fatal("blank names collapse to empty")
	}
	long := make([]rune, SessionNameMaxChars+1)
	for i := range long {
		long[i] = '字'
	}
	if _, err := NormalizeSessionName(string(long)); err == nil {
		t.Fatal("over-length name must fail")
	}
}

func TestKindExtensionAgreement(t *testing.T) {
	cases := []struct {
		kind Kind
		ext  string
		want bool
	}{
		{KindImage, ".png", true},
		{KindImage, ".JPG", true},
		{KindImage, ".mp4", false},
		{KindVideo, ".mp4", true},
		{KindAudio, ".m4a", true},
		{KindAudio, ".mp4", false},
	}
	for _, tc := range cases {
		if got := tc.kind.AcceptsExtension(tc.ext); got != tc.want {
			t.Errorf("%s ext %s = %v", tc.kind, tc.ext, got)
		}
	}
}

func TestMaterialFactsGuard(t *testing.T) {
	w := 4
	h := 2
	pixels := int64(8)
	dur := 500
	image := &ReferenceMaterial{Kind: KindImage, WidthPx: &w, HeightPx: &h, PixelCount: &pixels}
	if !image.HasMediaFacts() {
		t.Fatal("complete image facts rejected")
	}
	video := &ReferenceMaterial{Kind: KindVideo, WidthPx: &w, HeightPx: &h, DurationMS: &dur}
	if !video.HasMediaFacts() {
		t.Fatal("complete video facts rejected")
	}
	audio := &ReferenceMaterial{Kind: KindAudio, DurationMS: &dur}
	if !audio.HasMediaFacts() {
		t.Fatal("complete audio facts rejected")
	}
	broken := &ReferenceMaterial{Kind: KindImage, WidthPx: &w}
	if broken.HasMediaFacts() {
		t.Fatal("partial image facts accepted")
	}
}
