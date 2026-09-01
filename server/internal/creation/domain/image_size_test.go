package domain

import "testing"

// The pixel size table is the vendor 豆包生图 contract (OpenAPI x-size-map)
// shared by three consumers: the manifest's published sizes, the Kapon
// adapter's wire size, and the Workbench display. These tests pin the table's
// completeness against the accepted capability cross product, so a model,
// tier, or ratio added to the manifest immediately demands its size entry.
func TestImageSizeTableCoversAcceptedCrossProduct(t *testing.T) {
	for _, model := range AcceptedImageModels() {
		for _, ratio := range AcceptedImageRatios() {
			for _, resolution := range model.Resolutions {
				size, ok := ImageSizeFor(model.Model, ratio, resolution)
				if !ok {
					t.Fatalf("%s %s %s: accepted combination has no vendor size", model.Model, ratio, resolution)
				}
				if size.Width < 1 || size.Height < 1 {
					t.Fatalf("%s %s %s: size %+v is not a positive pixel resolution", model.Model, ratio, resolution, size)
				}
			}
		}
	}
}

func TestImageSizeTableFailsClosedOutsideTheCrossProduct(t *testing.T) {
	if _, ok := ImageSizeFor(ImageModelID, "7:5", "2K"); ok {
		t.Fatal("unknown ratio must fail closed")
	}
	// A tier another model publishes stays closed on a model whose own set
	// lacks it.
	if _, ok := ImageSizeFor(ImageModelID, "1:1", "4K"); ok {
		t.Fatal("4K on pro must fail closed: the tier belongs to n only")
	}
	if _, ok := ImageSizeFor(VideoModelID, "16:9", "720p"); ok {
		t.Fatal("video models have no pixel size contract")
	}
}

func TestImageSizeTablePinTheVendorExamples(t *testing.T) {
	// The vendor doc's distinguishing example: one tier label, different
	// pixels per model.
	pro, proOK := ImageSizeFor(ImageModelID, "16:9", "2K")
	n, nOK := ImageSizeFor(ImageModelBaseID, "16:9", "2K")
	if !proOK || pro != (ImageSize{Width: 2816, Height: 1584}) {
		t.Fatalf("pro 16:9 2K = %+v (ok=%v), want 2816x1584", pro, proOK)
	}
	if !nOK || n != (ImageSize{Width: 2848, Height: 1600}) {
		t.Fatalf("n 16:9 2K = %+v (ok=%v), want 2848x1600", n, nOK)
	}
	// The field-reported combination.
	vertical, ok := ImageSizeFor(ImageModelID, "9:16", "1K")
	if !ok || vertical != (ImageSize{Width: 800, Height: 1424}) {
		t.Fatalf("pro 9:16 1K = %+v (ok=%v), want 800x1424", vertical, ok)
	}
}
