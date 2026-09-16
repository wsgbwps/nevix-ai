package creationhttp

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/nevix-ai/server/internal/creation/application"
	"github.com/nevix-ai/server/internal/creation/domain"
)

type verifiedBlob struct {
	Key      string
	Mime     string
	Size     int64
	Checksum []byte
}

func streamVerifiedBlob(w http.ResponseWriter, r *http.Request, storage *application.ObjectStorageConnectionService, blob verifiedBlob) {
	if blob.Key == "" || blob.Size <= 0 || len(blob.Checksum) != sha256.Size {
		fail(w, r, domain.ErrObjectStorageUnavailable)
		return
	}
	store, _, err := storage.ResolveStore(r.Context())
	if err != nil {
		fail(w, r, err)
		return
	}
	intent := parseRangeIntent(r.Header.Get("Range"))
	partial, start, stop, satisfiable := resolveRange(intent, blob.Size)
	if intent.present && (!intent.valid || !satisfiable) {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", blob.Size))
		WriteError(w, &Error{Status: http.StatusRequestedRangeNotSatisfiable, Code: CodeRangeNotSatisfiable, Message: "The requested byte range cannot be satisfied."})
		return
	}
	reader, actualSize, err := store.Open(r.Context(), blob.Key, domain.BlobRange{Offset: start, Length: stop - start})
	if err != nil {
		fail(w, r, domain.ErrObjectStorageUnavailable)
		return
	}
	defer reader.Close()
	if actualSize != blob.Size {
		fail(w, r, domain.ErrObjectStorageUnavailable)
		return
	}
	if blob.Mime != "" {
		w.Header().Set("Content-Type", blob.Mime)
	}
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("X-Content-SHA-256", hex.EncodeToString(blob.Checksum))
	w.Header().Set("Content-Length", strconv.FormatInt(stop-start, 10))
	status := http.StatusOK
	if partial {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, stop-1, blob.Size))
		status = http.StatusPartialContent
	}
	w.WriteHeader(status)
	digest := sha256.New()
	flusher, canFlush := w.(http.Flusher)
	streamBytes := stop - start
	if !partial {
		// Hold the final byte so a full response completes only after checksum verification.
		streamBytes--
	}
	copied, err := pumpToClient(w, flusher, canFlush, digest, reader, streamBytes)
	if err != nil || copied != streamBytes {
		panic(http.ErrAbortHandler)
	}
	if !partial {
		tail := []byte{0}
		if _, err := io.ReadFull(reader, tail); err != nil {
			panic(http.ErrAbortHandler)
		}
		digest.Write(tail)
		if digestMismatch(digest, blob.Checksum) {
			panic(http.ErrAbortHandler)
		}
		if _, err := w.Write(tail); err != nil {
			panic(http.ErrAbortHandler)
		}
	}
}
