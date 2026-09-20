package domain

import (
	"math"
	"testing"
)

// The tolerance is only defensible if every published size lands in its own
// ratio's bounds and nobody else's: one shape, one row, no exceptions.
func TestRatioBoundsSeparatesEveryPublishedImageSize(t *testing.T) {
	ratios := AssetFacets(MediaImage).Ratios
	if len(ratios) == 0 {
		t.Fatal("no image ratio facets published")
	}
	checked := 0
	for _, model := range AcceptedImageModels() {
		for _, ratio := range ratios {
			for _, resolution := range model.Resolutions {
				size, ok := ImageSizeFor(model.Model, ratio, resolution)
				if !ok {
					continue
				}
				checked++
				shape := float64(size.Width) / float64(size.Height)
				matched := make([]string, 0, 2)
				for _, candidate := range ratios {
					lo, hi, _ := RatioBounds(candidate)
					if shape >= lo && shape <= hi {
						matched = append(matched, candidate)
					}
				}
				if len(matched) != 1 || matched[0] != ratio {
					t.Fatalf("%s %s %s is %dx%d (shape %.4f), matched %v, want [%s]",
						model.Model, ratio, resolution, size.Width, size.Height, shape, matched, ratio)
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("no published sizes were checked")
	}
}

func TestAssetFacetsPublishesFilterableValuesOnly(t *testing.T) {
	image, video := AssetFacets(MediaImage), AssetFacets(MediaVideo)
	if containsString(video.Ratios, "adaptive") {
		t.Fatal("the adaptive sentinel is not a ratio row")
	}
	if _, _, ok := RatioBounds("adaptive"); ok {
		t.Fatal("adaptive parsed as an expressible ratio")
	}
	if !containsString(image.Modes, ModeTextToImage) || !containsString(video.Modes, ModeFirstLastFrame) {
		t.Fatalf("modes missing: image=%v video=%v", image.Modes, video.Modes)
	}
	if containsString(image.Resolutions, "1080p") || containsString(video.Resolutions, "2K") {
		t.Fatalf("resolutions crossed medias: image=%v video=%v", image.Resolutions, video.Resolutions)
	}
	for _, ratio := range append(append([]string{}, image.Ratios...), video.Ratios...) {
		if _, _, ok := RatioBounds(ratio); !ok {
			t.Fatalf("%q was published as a ratio row but has no shape", ratio)
		}
	}
}

func TestAssetFacetsOrderRatiosWidestFirst(t *testing.T) {
	for _, media := range []MediaType{MediaImage, MediaVideo} {
		ratios := AssetFacets(media).Ratios
		for i := 1; i < len(ratios); i++ {
			previous, _ := ratioValue(ratios[i-1])
			current, _ := ratioValue(ratios[i])
			if previous < current {
				t.Fatalf("%s ratios are not widest first: %v", media, ratios)
			}
		}
	}
}

func TestAcceptedAssetFacetsIsTheUnionAndRejectsNonRatios(t *testing.T) {
	accepted := AcceptedAssetFacets()
	if !containsString(accepted.Modes, ModeTextToImage) || !containsString(accepted.Modes, ModeOmniReference) {
		t.Fatalf("modes=%v", accepted.Modes)
	}
	if !containsString(accepted.Resolutions, "4K") || !containsString(accepted.Resolutions, "480p") {
		t.Fatalf("resolutions=%v", accepted.Resolutions)
	}
	if containsString(accepted.Ratios, "adaptive") || containsString(accepted.Ratios, "banana") {
		t.Fatalf("ratios=%v", accepted.Ratios)
	}
}

// The band is ±3% of the ratio itself, one margin on each side. Reading the
// lower edge as r/Tolerance instead would pull it to 97.087% and narrow the
// band asymmetrically, which no published size justifies.
func TestRatioBoundsKeepTheStatedThreePercentMargin(t *testing.T) {
	value := 16.0 / 9.0
	lo, hi, ok := RatioBounds("16:9")
	if !ok {
		t.Fatal("16:9 is not an expressible ratio")
	}
	for _, side := range []struct {
		name     string
		bound    float64
		expected float64
	}{
		{"lower", lo, -RatioShapeTolerance},
		{"upper", hi, RatioShapeTolerance},
	} {
		if deviation := (side.bound - value) / value; math.Abs(deviation-side.expected) > 1e-9 {
			t.Fatalf("%s bound %v sits %.6f%% off %v, want %.6f%%",
				side.name, side.bound, deviation*100, value, side.expected*100)
		}
	}
}

func TestRatioBoundsReadsShape(t *testing.T) {
	lo, hi, ok := RatioBounds(" 16 : 9 ")
	want := 16.0 / 9.0
	if !ok || lo >= want || hi <= want {
		t.Fatalf("lo=%v hi=%v ok=%v", lo, hi, ok)
	}
	for _, bad := range []string{"adaptive", "", "16x9", "16:0", "0:9", "a:b", "16:"} {
		if _, _, ok := RatioBounds(bad); ok {
			t.Fatalf("%q parsed as a ratio", bad)
		}
	}
}
