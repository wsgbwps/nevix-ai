package creationhttp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"io"
	"log/slog"
	"mime"
	"net/http"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// streamBufferLen bounds every transfer's memory footprint to one buffer no
// matter the blob size.
const streamBufferLen = 256 << 10

// UploadMaterial answers POST /creation/sessions/{sessionID}/materials. The
// single file part streams straight into the storage seam; nothing about the
// body is buffered whole, and the authoritative sniff/extension/probe
// pipeline runs inside the service.
func (h *MaterialHandler) UploadMaterial(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := pathUUID(w, r, "sessionID")
	if !ok {
		return
	}
	if mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mediaType != "multipart/form-data" {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "Uploads must be multipart/form-data."})
		return
	}
	formReader, err := r.MultipartReader()
	if err != nil {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeUploadMalformed, Message: "The multipart body could not be read."})
		return
	}

	// The file part must be captured WITHOUT walking further parts: calling
	// NextPart again makes multipart.Reader consume whatever this part has
	// not streamed yet, so the only strictness available once streaming starts
	// is the documented schema — one file part (extra framing parts are left
	// for net/http to drain with the request).
	var fileName string
	var body io.Reader
	sawFile := false
	for !sawFile {
		part, partErr := formReader.NextPart()
		if partErr == io.EOF {
			break
		}
		if partErr != nil {
			WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeUploadMalformed, Message: "The multipart body was truncated or malformed."})
			return
		}
		if part.FormName() != "file" {
			part.Close()
			continue // metadata fields are legal framing; the schema ignores them
		}
		if part.FileName() == "" {
			part.Close()
			WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "The file part must carry a filename."})
			return
		}
		fileName = part.FileName()
		body = part
		defer part.Close()
		sawFile = true
	}
	if !sawFile {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "The file part is required."})
		return
	}

	material, uploadErr := h.materials.Upload(r.Context(), creatorID(w, r), sessionID, fileName, body)
	if uploadErr != nil {
		fail(w, r, uploadErr)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if encodeErr := json.NewEncoder(w).Encode(toMaterialResource(material)); encodeErr != nil {
		slog.Error("creation: encode upload response", "error", encodeErr)
	}
}

// DownloadMaterial answers GET /creation/materials/{materialID}, serving the
// whole blob or one byte range. The storage window always opens whole and
// Range serving seeks inside it, so neither adapter needs an extra round trip
// per request shape. Hashing rides the stream: served bytes that stop
// matching the recorded digest sever the connection instead of completing a
// corrupt transfer.
func (h *MaterialHandler) DownloadMaterial(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "materialID")
	if !ok {
		return
	}

	intent := parseRangeIntent(r.Header.Get("Range"))
	material, reader, size, openErr := h.materials.OpenForDownload(r.Context(), creatorID(w, r), id, domain.FullBlobRange)
	if openErr != nil {
		fail(w, r, openErr)
		return
	}
	defer reader.Close()

	// The contract documents 416 for multi-range, syntactically invalid, and
	// unsatisfiable specs alike (contracts/creation.yaml RangeNotSatisfiable):
	// present-but-invalid is rejected explicitly instead of silently serving
	// the whole blob to a client that asked for a slice.
	servePartial, start, stop, satisfiable := resolveRange(intent, size)
	if intent.present && (!intent.valid || !satisfiable) {
		WriteError(w, &Error{
			Status:  http.StatusRequestedRangeNotSatisfiable,
			Code:    CodeRangeNotSatisfiable,
			Message: fmt.Sprintf("Requested range cannot be satisfied for %d byte object.", size),
		})
		return
	}

	checksumHex := ""
	if len(material.ChecksumSHA256) == 32 {
		checksumHex = hex.EncodeToString(material.ChecksumSHA256)
	}
	w.Header().Set("X-Content-SHA-256", checksumHex)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Type", material.MimeType)

	copiedTarget := size
	status := http.StatusOK
	if servePartial {
		copiedTarget = stop - start
		if _, seekErr := reader.Seek(start, io.SeekStart); seekErr != nil {
			fail(w, r, seekErr)
			return
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, stop-1, size))
		w.Header().Set("Content-Length", fmt.Sprintf("%d", copiedTarget))
		status = http.StatusPartialContent
	} else {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", copiedTarget))
	}
	w.WriteHeader(status)

	hasher := sha256.New()
	flusher, canFlush := w.(http.Flusher)
	copied, copyErr := pumpToClient(w, flusher, canFlush, hasher, reader, copiedTarget)
	switch {
	case copyErr != nil && clientGone(r.Context()):
		// Client stopped reading; net/http ends the request silently.
	case copyErr != nil:
		slog.Warn("creation: download aborted mid-stream", "material_id", material.ID.String(), "error", copyErr)
		severConnection(w)
	case copied == size && digestMismatch(hasher, material.ChecksumSHA256):
		slog.Error("creation: served bytes failed checksum verification", "material_id", material.ID.String())
		severConnection(w)
	}
}

// clientGone reports whether the caller stopped reading.
func clientGone(ctx context.Context) bool {
	return ctx.Err() != nil
}

// digestMismatch compares streamed bytes against the stored digest. Only
// full transfers can reproduce it — partial serves skip the verdict.
func digestMismatch(hasher hash.Hash, want []byte) bool {
	sum := hasher.Sum(nil)
	if len(sum) != len(want) {
		return true
	}
	for i := range sum {
		if sum[i] != want[i] {
			return true
		}
	}
	return false
}

// severConnection drops the TCP connection mid-response so corrupt payloads
// end as broken transfers instead of silent truncation.
func severConnection(w http.ResponseWriter) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		panic("creationhttp: response writer cannot hijack for integrity abort")
	}
	conn, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	_ = buffered.Flush()
	conn.Close()
}

// pumpToClient copies up to maxBytes from storage to the wire through one
// fixed buffer, hashing served bytes along the way and flushing per chunk so
// no intermediary buffers whole bodies behind this server's back.
func pumpToClient(
	w io.Writer,
	flusher http.Flusher,
	canFlush bool,
	hasher hash.Hash,
	reader io.Reader,
	maxBytes int64,
) (int64, error) {
	buffer := make([]byte, streamBufferLen)
	var written int64
	for written < maxBytes {
		chunkCap := int64(len(buffer))
		if remaining := maxBytes - written; remaining < chunkCap {
			chunkCap = remaining
		}
		n, readErr := reader.Read(buffer[:chunkCap])
		if n > 0 {
			chunk := buffer[:n]
			hasher.Write(chunk)
			servedChunk, writeErr := w.Write(chunk)
			written += int64(servedChunk)
			if writeErr != nil {
				return written, writeErr
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if readErr == io.EOF || readErr == io.ErrUnexpectedEOF {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
	return written, nil
}
