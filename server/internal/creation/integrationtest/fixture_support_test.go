package integrationtest

import (
	"bytes"
	"encoding/binary"
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

// pngBytes encodes a 256x256 PNG used to exercise the authoritative image
// path: the same size envelope the manifest publishes and the upload gate
// enforces (spec 图片合同).
func pngBytes(t *testing.T) []byte {
	t.Helper()
	return pngBytesSized(t, 256, 256)
}

// pngBytesSized encodes a deterministic w×h PNG for envelope-boundary cases.
func pngBytesSized(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, fixtureImage(w, h)); err != nil {
		t.Fatalf("encode %dx%d png fixture: %v", w, h, err)
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

// mp4Fixture synthesizes a minimal H.264 MP4 the authoritative probe accepts;
// box layouts mirror the fields identifyMP4 reads (media package prior art).
func mp4Fixture() []byte {
	versioned := []byte{0x00, 0x00, 0x00, 0x00}

	mvhd := make([]byte, 96)
	copy(mvhd, versioned)
	binary.BigEndian.PutUint32(mvhd[12:16], 1000) // timescale
	binary.BigEndian.PutUint32(mvhd[16:20], 5000) // duration (5s)
	mvhdBox := mp4BoxFixture("mvhd", mvhd)

	mdhd := mp4BoxFixture("mdhd", make([]byte, 28))

	hdlr := make([]byte, 24)
	copy(hdlr, versioned)
	copy(hdlr[8:12], "vide")
	hdlrBox := mp4BoxFixture("hdlr", hdlr)

	vmhd := append(append([]byte{}, versioned...), make([]byte, 12)...)
	entry := make([]byte, 36)
	binary.BigEndian.PutUint32(entry[0:4], 36)
	copy(entry[4:8], "avc1")
	binary.BigEndian.PutUint16(entry[32:34], 64)
	binary.BigEndian.PutUint16(entry[34:36], 48)
	stsdPayload := append(append([]byte{}, versioned...), 0, 0, 0, 1)
	stsdPayload = append(stsdPayload, entry...)
	stblBox := mp4BoxFixture("stbl", mp4BoxFixture("stsd", stsdPayload))
	minfBox := mp4BoxFixture("minf", mp4ConcatFixture(mp4BoxFixture("vmhd", vmhd), stblBox))
	mdiaBox := mp4BoxFixture("mdia", mp4ConcatFixture(mdhd, hdlrBox, minfBox))
	trakBox := mp4BoxFixture("trak", mdiaBox)
	moovBox := mp4BoxFixture("moov", mp4ConcatFixture(mvhdBox, trakBox))
	ftypBox := mp4BoxFixture("ftyp", []byte("isom\x00\x00\x02\x00isomiso2avc1"))
	datBox := mp4BoxFixture("mdat", bytes.Repeat([]byte{0xAB}, 64))
	return mp4ConcatFixture(ftypBox, moovBox, datBox)
}

func mp4BoxFixture(ftype string, payload []byte) []byte {
	out := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint32(out[0:4], uint32(len(payload)+8))
	copy(out[4:8], ftype)
	copy(out[8:], payload)
	return out
}

func mp4ConcatFixture(parts ...[]byte) []byte {
	var buf bytes.Buffer
	for _, part := range parts {
		buf.Write(part)
	}
	return buf.Bytes()
}
