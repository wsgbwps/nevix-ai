package creationhttp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"log/slog"
	"net/http"

	"github.com/nevix-ai/server/internal/creation/application"
	"github.com/nevix-ai/server/internal/creation/domain"
)

// streamBufferLen bounds every transfer's memory footprint to one buffer no
// matter the blob size.
const streamBufferLen = 256 << 10

type createReferenceMaterialUploadRequest struct {
	IdempotencyKey   *string `json:"idempotency_key"`
	FileName         *string `json:"file_name"`
	DeclaredKind     *string `json:"declared_kind"`
	DeclaredMIMEType *string `json:"declared_mime_type"`
	DeclaredByteSize *int64  `json:"declared_byte_size"`
}

type referenceMaterialUploadResource struct {
	ID                 string  `json:"id"`
	SessionID          string  `json:"session_id"`
	Status             string  `json:"status"`
	FileName           string  `json:"file_name"`
	DeclaredKind       string  `json:"declared_kind"`
	DeclaredMIMEType   string  `json:"declared_mime_type"`
	DeclaredByteSize   int64   `json:"declared_byte_size"`
	ClaimsVersion      int     `json:"claims_version"`
	ConnectionRevision int64   `json:"connection_revision"`
	PutExpiresAt       string  `json:"put_expires_at"`
	FinalizeExpiresAt  string  `json:"finalize_expires_at"`
	CreatedAt          string  `json:"created_at"`
	FinalizedAt        *string `json:"finalized_at,omitempty"`
}

func toReferenceMaterialUploadResource(upload domain.ReferenceMaterialUpload) referenceMaterialUploadResource {
	var finalizedAt *string
	if upload.FinalizedAt != nil {
		formatted := upload.FinalizedAt.UTC().Format(timeRFC3339)
		finalizedAt = &formatted
	}
	return referenceMaterialUploadResource{
		ID: upload.ID.String(), SessionID: upload.SessionID.String(), Status: string(upload.Status),
		FileName: upload.FileName, DeclaredKind: string(upload.DeclaredKind),
		DeclaredMIMEType: upload.DeclaredMIMEType, DeclaredByteSize: upload.DeclaredByteSize,
		ClaimsVersion: upload.ClaimsVersion, ConnectionRevision: upload.ConnectionRevision,
		PutExpiresAt:      upload.PutDeadline.UTC().Format(timeRFC3339),
		FinalizeExpiresAt: upload.FinalizeDeadline.UTC().Format(timeRFC3339),
		CreatedAt:         upload.CreatedAt.UTC().Format(timeRFC3339), FinalizedAt: finalizedAt,
	}
}

type referenceMaterialUploadRequestResource struct {
	Method    string            `json:"method"`
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt string            `json:"expires_at"`
}

type referenceMaterialUploadAuthorizationResponse struct {
	Upload        referenceMaterialUploadResource         `json:"upload"`
	UploadRequest *referenceMaterialUploadRequestResource `json:"upload_request,omitempty"`
}

type referenceMaterialUploadStatusResponse struct {
	Upload   referenceMaterialUploadResource `json:"upload"`
	Material *materialResource               `json:"material,omitempty"`
}

// CreateReferenceMaterialUpload persists one creator-private upload lease and
// returns only its exact, expiring PUT request.
func (h *MaterialHandler) CreateReferenceMaterialUpload(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := pathUUID(w, r, "sessionID")
	if !ok {
		return
	}
	var req createReferenceMaterialUploadRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.IdempotencyKey == nil || req.FileName == nil || req.DeclaredKind == nil || req.DeclaredMIMEType == nil || req.DeclaredByteSize == nil {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "The upload declaration is incomplete."})
		return
	}
	authorization, err := h.materials.CreateUpload(r.Context(), creatorID(w, r), sessionID, application.ReferenceMaterialUploadInput{
		IdempotencyKey: *req.IdempotencyKey, FileName: *req.FileName,
		DeclaredKind: domain.Kind(*req.DeclaredKind), DeclaredMIMEType: *req.DeclaredMIMEType,
		DeclaredByteSize: *req.DeclaredByteSize,
	})
	if err != nil {
		fail(w, r, err)
		return
	}
	status := http.StatusOK
	if authorization.Created {
		status = http.StatusCreated
	}
	response := referenceMaterialUploadAuthorizationResponse{Upload: toReferenceMaterialUploadResource(authorization.Upload)}
	if authorization.Request != nil {
		response.UploadRequest = &referenceMaterialUploadRequestResource{
			Method: authorization.Request.Method, URL: authorization.Request.URL,
			Headers:   authorization.Request.Headers,
			ExpiresAt: authorization.Request.ExpiresAt.UTC().Format(timeRFC3339),
		}
	}
	encodeJSON(w, status, response)
}

func (h *MaterialHandler) GetReferenceMaterialUpload(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "uploadID")
	if !ok {
		return
	}
	status, err := h.materials.GetUpload(r.Context(), creatorID(w, r), id)
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, toReferenceMaterialUploadStatusResponse(status))
}

func (h *MaterialHandler) FinalizeReferenceMaterialUpload(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "uploadID")
	if !ok {
		return
	}
	status, err := h.materials.FinalizeUpload(r.Context(), creatorID(w, r), id)
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, toReferenceMaterialUploadStatusResponse(status))
}

func toReferenceMaterialUploadStatusResponse(status application.ReferenceMaterialUploadStatus) referenceMaterialUploadStatusResponse {
	response := referenceMaterialUploadStatusResponse{Upload: toReferenceMaterialUploadResource(status.Upload)}
	if status.Material != nil {
		material := toMaterialResource(*status.Material)
		response.Material = &material
	}
	return response
}

type referenceMaterialFromResultRequest struct {
	TaskID    *string `json:"task_id"`
	SlotIndex *int    `json:"slot_index"`
	FileName  *string `json:"file_name"`
}

func (h *MaterialHandler) CreateReferenceMaterialFromResult(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := pathUUID(w, r, "sessionID")
	if !ok {
		return
	}
	var req referenceMaterialFromResultRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.TaskID == nil || req.SlotIndex == nil || req.FileName == nil {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "task_id, slot_index, and file_name are required."})
		return
	}
	taskID, err := domain.ParseUUID(*req.TaskID)
	if err != nil {
		WriteError(w, &Error{Status: http.StatusNotFound, Code: CodeNotFound, Message: "The requested resource was not found."})
		return
	}
	material, err := h.materials.CreateFromResult(r.Context(), creatorID(w, r), sessionID, taskID, *req.SlotIndex, *req.FileName)
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusCreated, toMaterialResource(material))
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
