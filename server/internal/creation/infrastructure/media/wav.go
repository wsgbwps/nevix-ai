package media

import (
	"encoding/binary"
	"io"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// identifyWAV walks the RIFF chunk list for fmt and data. PCM (1) and IEEE
// float (3) encodings are accepted; byte-rate division yields the duration
// with the data chunk clamped to the blob so an inconsistent header cannot
// invent length.
func identifyWAV(seek io.ReadSeeker) (domain.Identified, error) {
	total, err := seek.Seek(0, io.SeekEnd)
	if err != nil || total < 44 {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}

	var (
		byteRate    int64 = 0
		dataFrom    int64 = -1
		dataTo      int64 = -1
		audioFormat uint16
	)
	pos := int64(12) // RIFF(12-byte descriptor) ends here
	for pos+8 <= total {
		header := make([]byte, 8)
		if _, err := readAtOffset(seek, header, pos); err != nil {
			return domain.Identified{}, domain.ErrUnreadableMedia
		}
		chunkType := string(header[0:4])
		size := int64(binary.LittleEndian.Uint32(header[4:8]))
		body := pos + 8
		switch chunkType {
		case "fmt ":
			fmtBody := make([]byte, size)
			if size < 16 || body+size > total {
				return domain.Identified{}, domain.ErrUnreadableMedia
			}
			if _, err := readAtOffset(seek, fmtBody, body); err != nil {
				return domain.Identified{}, domain.ErrUnreadableMedia
			}
			audioFormat = binary.LittleEndian.Uint16(fmtBody[0:2])
			channels := int64(binary.LittleEndian.Uint16(fmtBody[2:4]))
			sampleRate := int64(binary.LittleEndian.Uint32(fmtBody[4:8]))
			bitsPerSample := int64(binary.LittleEndian.Uint16(fmtBody[14:16]))
			blockAlignOverride := binary.LittleEndian.Uint16(fmtBody[12:14])
			if channels == 0 || sampleRate == 0 || bitsPerSample == 0 {
				return domain.Identified{}, domain.ErrUnreadableMedia
			}
			computedAlign := channels * bitsPerSample / 8
			align := int64(blockAlignOverride)
			if align == 0 {
				align = computedAlign
			}
			byteRate = sampleRate * align
			dataFrom = -1 // fmt may appear again; keep the last one before data
		case "data":
			if dataFrom < 0 && audioFormat != 0 {
				dataFrom = body
				end := body + size
				if size == 0 || end > total {
					end = total
				}
				dataTo = end
			}
		}
		pos = body + size
		if size%2 == 1 {
			pos++ // RIFF chunks pad to even offsets
		}
	}
	if byteRate <= 0 || dataFrom < 0 || dataTo <= dataFrom {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	if audioFormat != 1 && audioFormat != 3 {
		return domain.Identified{}, domain.ErrUnsupportedMedia
	}
	durationMS := int((dataTo - dataFrom) * 1000 / byteRate)
	if durationMS <= 0 {
		return domain.Identified{}, domain.ErrUnreadableMedia
	}
	return domain.Identified{
		Kind: domain.KindAudio,
		Facts: domain.MediaFacts{
			MimeType:   "audio/x-wav",
			DurationMS: intPtr(durationMS),
		},
	}, nil
}
