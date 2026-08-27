package media

import (
	"bytes"
	"image"
	"io"

	_ "image/jpeg" // register the JPEG decoder
	_ "image/png"  // register the PNG decoder

	"golang.org/x/image/webp"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// identifyImage decodes the whole image body. Images are capped far below
// memory-unsafe sizes at ingestion, so a full decode is both affordable and
// the honest readability test: truncated or corrupt files fail here instead
// of surfacing as broken content later.
func identifyImage(family Family, seek io.ReadSeeker) (domain.Identified, error) {
	if _, err := seek.Seek(0, io.SeekStart); err != nil {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	body, err := io.ReadAll(seek)
	if err != nil || len(body) == 0 {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	reader := bytes.NewReader(body)
	var (
		img       image.Image
		decodeErr error
	)
	if family == FamilyWebP {
		img, decodeErr = webp.Decode(reader)
	} else {
		img, _, decodeErr = image.Decode(reader)
	}
	if decodeErr != nil || img == nil {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	pixels := int64(width) * int64(height)
	return domain.Identified{
		Kind: domain.KindImage,
		Facts: domain.MediaFacts{
			MimeType:   canonicalImageMIME(family),
			WidthPx:    intPtr(width),
			HeightPx:   intPtr(height),
			PixelCount: i64Ptr(pixels),
		},
	}, nil
}

func canonicalImageMIME(family Family) string {
	switch family {
	case FamilyJPEG:
		return "image/jpeg"
	case FamilyPNG:
		return "image/png"
	case FamilyWebP:
		return "image/webp"
	default:
		return ""
	}
}
