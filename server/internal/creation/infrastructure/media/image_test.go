package media

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// drawFixed produces a deterministic 320x200 gradient.
func drawFixed() *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, 320, 200))
	for y := 0; y < 200; y++ {
		for x := 0; x < 320; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 128, A: 255})
		}
	}
	return img
}

func encodePNG(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, drawFixed()); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func encodeJPEG(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, drawFixed(), nil); err != nil {
		t.Fatalf("encode jpeg: %v", err)
	}
	return buf.Bytes()
}

// mustBase64WebPLossy decodes a canonical 1x1 lossy WebP byte blob so the
// test suite carries no binary assets while still exercising the x/image
// decoder path.
const webPLossy1x1 = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="

func decodeWebP(t *testing.T) []byte {
	t.Helper()
	blob, err := base64.StdEncoding.DecodeString(webPLossy1x1)
	if err != nil {
		t.Fatalf("decode embedded webp fixture: %v", err)
	}
	return blob
}

func TestIdentifyImageReportsDimensionsPixelsAndMIME(t *testing.T) {
	cases := []struct {
		name string
		blob func(t *testing.T) []byte
		mime string
	}{
		{"png", encodePNG, "image/png"},
		{"jpeg", encodeJPEG, "image/jpeg"},
		{"webp-lossy", decodeWebP, "image/webp"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Identify(bytes.NewReader(tc.blob(t)))
			if err != nil {
				t.Fatalf("identify: %v", err)
			}
			if got.Kind != domain.KindImage {
				t.Fatalf("kind %q", got.Kind)
			}
			if got.Facts.MimeType != tc.mime {
				t.Fatalf("mime %q want %q", got.Facts.MimeType, tc.mime)
			}
			// The embedded webp fixture is 1x1; the encoded gradients are not.
			wantW, wantH, wantPixels := 320, 200, int64(64000)
			if tc.name == "webp-lossy" {
				wantW, wantH, wantPixels = 1, 1, 1
			}
			if got.Facts.WidthPx == nil || *got.Facts.WidthPx != wantW ||
				got.Facts.HeightPx == nil || *got.Facts.HeightPx != wantH {
				t.Fatalf("dimensions %+v", got.Facts)
			}
			if got.Facts.PixelCount == nil || *got.Facts.PixelCount != wantPixels {
				t.Fatalf("pixels %+v", got.Facts.PixelCount)
			}
			if got.Facts.DurationMS != nil {
				t.Fatal("images must not carry duration")
			}
		})
	}
}

func TestIdentifyRejectsCorruptContent(t *testing.T) {
	full := encodePNG(t)
	cases := map[string][]byte{
		"truncated": full[:48],
		"garbage":   []byte("this is not a media file at all"),
		"empty":     {},
	}
	for name, blob := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Identify(bytes.NewReader(blob)); err == nil {
				t.Fatal("corrupt content must fail identification")
			}
		})
	}
}

func TestSniffFamilies(t *testing.T) {
	mp4Head := make([]byte, 16)
	copy(mp4Head[4:], "ftypisom")
	wavHead := append([]byte("RIFF"), append([]byte{0x24, 0x08, 0x00, 0x00}, []byte("WAVE")...)...)
	webpHead := append([]byte("RIFF"), append([]byte{0, 0, 0, 0}, []byte("WEBP")...)...)
	cases := map[string]struct {
		head []byte
		want Family
	}{
		"jpeg": {[]byte{0xFF, 0xD8, 0xFF, 0xE0}, FamilyJPEG},
		"png":  {[]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'}, FamilyPNG},
		"webp": {webpHead, FamilyWebP},
		"mp4":  {mp4Head, FamilyMP4},
		"wav":  {wavHead, FamilyWAV},
		"id3":  {[]byte("ID3\x04\x00\x00\x00\x00\x00\x00"), FamilyMP3},
		"sync": {[]byte{0xFF, 0xFB, 0x90, 0x00}, FamilyMP3},
		"text": {[]byte("plain text"), FamilyUnknown},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := Sniff(tc.head); got != tc.want {
				t.Fatalf("sniff %v want %v", got, tc.want)
			}
		})
	}
}
