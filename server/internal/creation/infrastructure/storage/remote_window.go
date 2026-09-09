package storage

import (
	"context"
	"fmt"
	"io"
	"sync"

	"github.com/nevix-ai/server/internal/creation/domain"
)

type openRemoteRange func(context.Context, int64, int64) (io.ReadCloser, error)

// remoteWindow provides seek without buffering a cloud object: each seek
// closes the current response and the next read opens one exact byte range.
type remoteWindow struct {
	ctx         context.Context
	open        openRemoteRange
	start, stop int64
	pos         int64
	mu          sync.Mutex
	current     io.ReadCloser
	done        chan struct{}
	closeOnce   sync.Once
	closed      bool
}

func newRemoteWindow(ctx context.Context, rng domain.BlobRange, size int64, open openRemoteRange) *remoteWindow {
	start := clampOffset(rng.Offset, size)
	stop := size
	if rng.Length >= 0 && start+rng.Length < stop {
		stop = start + rng.Length
	}
	w := &remoteWindow{ctx: ctx, open: open, start: start, stop: stop, pos: start, done: make(chan struct{})}
	go func() {
		select {
		case <-ctx.Done():
			w.closeCurrent()
		case <-w.done:
		}
	}()
	return w
}

func (w *remoteWindow) Read(p []byte) (int, error) {
	if w.pos >= w.stop {
		return 0, io.EOF
	}
	w.mu.Lock()
	current := w.current
	w.mu.Unlock()
	if current == nil {
		stream, err := w.open(w.ctx, w.pos, w.stop)
		if err != nil {
			return 0, err
		}
		w.mu.Lock()
		if w.closed {
			w.mu.Unlock()
			stream.Close()
			return 0, io.ErrClosedPipe
		}
		if err := w.ctx.Err(); err != nil {
			w.mu.Unlock()
			stream.Close()
			return 0, err
		}
		w.current = stream
		current = stream
		w.mu.Unlock()
	}
	if remaining := w.stop - w.pos; int64(len(p)) > remaining {
		p = p[:remaining]
	}
	n, err := current.Read(p)
	w.pos += int64(n)
	if w.pos >= w.stop {
		w.closeCurrent()
	}
	return n, err
}

func (w *remoteWindow) Seek(offset int64, whence int) (int64, error) {
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

func (w *remoteWindow) closeCurrent() {
	w.mu.Lock()
	current := w.current
	w.current = nil
	w.mu.Unlock()
	if current != nil {
		current.Close()
	}
}

func (w *remoteWindow) Close() error {
	w.closeOnce.Do(func() {
		w.mu.Lock()
		w.closed = true
		current := w.current
		w.current = nil
		w.mu.Unlock()
		close(w.done)
		if current != nil {
			current.Close()
		}
	})
	return nil
}
