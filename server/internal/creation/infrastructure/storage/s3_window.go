package storage

import (
	"context"
	"fmt"
	"io"

	"github.com/minio/minio-go/v7"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// s3Window is one seekable [start,stop) window over an S3 object. Streams
// are opened lazily at the current position so probing and Range downloads
// only transfer the bytes they actually touch; context death closes the
// active stream promptly instead of waiting for connection teardown.
type s3Window struct {
	store        *S3Store
	key          string
	ctx          context.Context
	start, stop  int64
	pos          int64
	current      io.ReadCloser
	currentStart int64
}

func newS3Window(ctx context.Context, store *S3Store, key string, rng domain.BlobRange, size int64) (*s3Window, error) {
	start := clampOffset(rng.Offset, size)
	stop := size
	if rng.Length >= 0 {
		stop = start + rng.Length
		if stop > size {
			stop = size
		}
	}
	if start > stop {
		start = stop
	}
	window := &s3Window{
		store: store,
		key:   key,
		ctx:   ctx,
		start: start,
		stop:  stop,
		pos:   start,
	}
	go func() {
		<-ctx.Done()
		window.closeCurrent()
	}()
	return window, nil
}

// openAt starts a fresh provider stream covering [from, stop). MinIO maps a
// bad range onto the documented behavior of returning fewer bytes; EOF past
// stop is enforced locally instead.
func (w *s3Window) openAt(from int64) error {
	opts := minio.GetObjectOptions{}
	var rangeHeader string
	switch {
	case w.stop < 0 && w.pos == 0:
		rangeHeader = "" // whole blob
	case w.stop < 0:
		rangeHeader = fmt.Sprintf("bytes=%d-", from)
	default:
		if from >= w.stop {
			w.current = nil
			return nil
		}
		rangeHeader = fmt.Sprintf("bytes=%d-%d", from, w.stop-1)
	}
	if rangeHeader != "" {
		opts.Set("Range", rangeHeader)
	}
	stream, err := w.store.client.GetObject(w.ctx, w.store.bucket, w.key, opts)
	if err != nil {
		return err
	}
	w.current = stream
	w.currentStart = from
	return nil
}

func (w *s3Window) Read(p []byte) (int, error) {
	if w.pos >= w.stop {
		return 0, io.EOF
	}
	if w.current == nil {
		if err := w.openAt(w.pos); err != nil {
			return 0, fmt.Errorf("creation: reopen blob window: %w", err)
		}
	}
	n, err := w.current.Read(p)
	w.pos += int64(n)
	if n > 0 && w.pos >= w.stop {
		w.closeCurrent()
	}
	return n, err
}

// Seek supports absolute, relative, and end-relative movement within the
// window; movement always closes the live stream so the next Read reopens
// exactly where needed rather than draining skipped bytes.
func (w *s3Window) Seek(offset int64, whence int) (int64, error) {
	base := w.pos
	switch whence {
	case io.SeekStart:
		base = w.start
	case io.SeekEnd:
		base = w.stop
	}
	next := base + offset
	if next < w.start {
		return 0, fmt.Errorf("creation: seek before window start: %d", offset)
	}
	if next > w.stop {
		next = w.stop
	}
	w.closeCurrent()
	w.pos = next
	return next - w.start, nil
}

func (w *s3Window) closeCurrent() {
	if w.current != nil {
		w.current.Close()
		w.current = nil
	}
}

func (w *s3Window) Close() error {
	w.closeCurrent()
	return nil
}
