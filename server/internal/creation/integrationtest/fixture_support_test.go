package integrationtest

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

// fixtureImage renders the deterministic raster every upload fixture uses.
func fixtureImage(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 96, A: 255})
		}
	}
	return img
}

// pngBytes encodes a 24x16 PNG used to exercise the authoritative image path.
func pngBytes(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, fixtureImage(24, 16)); err != nil {
		t.Fatalf("encode png fixture: %v", err)
	}
	return buf.Bytes()
}

// jpegBytes exercises the second accepted raster family.
func jpegBytes(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, fixtureImage(32, 32), nil); err != nil {
		t.Fatalf("encode jpeg fixture: %v", err)
	}
	return buf.Bytes()
}
