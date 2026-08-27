// Package storage holds the two production blob adapters behind the Creation
// Module's domain.BlobStore port: a local filesystem store and an
// S3-compatible store. Both satisfy the same conformance suite and neither
// ever hands credentials or pre-signed URLs to Desktop clients (ADR-0014):
// every byte moves through Go with bounded buffers.
package storage

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// copyBufferLen is the streaming window used by both adapters' upload loops:
// memory per active transfer stays at one buffer regardless of blob size,
// which is what the contract means by 有界缓冲.
const copyBufferLen = 256 << 10

// FilesystemStore keeps blobs under one configured root, sharded by UUID
// prefix so no directory grows without bound.
type FilesystemStore struct {
	root string
}

// NewFilesystem prepares the storage root. The caller owns configuring an
// absolute path that the runtime user may write.
func NewFilesystem(root string) (*FilesystemStore, error) {
	normalized := filepath.Clean(root)
	if !filepath.IsAbs(normalized) {
		return nil, fmt.Errorf("creation: filesystem storage root %q must be absolute", root)
	}
	if err := os.MkdirAll(normalized, 0o750); err != nil {
		return nil, fmt.Errorf("creation: prepare filesystem storage root: %w", err)
	}
	return &FilesystemStore{root: normalized}, nil
}

// resolve joins key under root and refuses anything that would escape it.
// Keys are derived above today; the guard makes traversal fail closed even
// if a future caller hands in attacker-influenced text.
func (s *FilesystemStore) resolve(key string) (string, error) {
	clean := filepath.Clean(strings.TrimPrefix(filepath.ToSlash(key), "/"))
	full := filepath.Join(s.root, clean)
	if full != s.root && !strings.HasPrefix(full, s.root+string(os.PathSeparator)) {
		return "", fmt.Errorf("creation: storage key %q escapes the root", key)
	}
	return full, nil
}

// Put streams src into place through a staging file and an atomic rename, so
// a failed or canceled upload never leaves a readable partial blob at the
// final address. The SHA-256 digest accumulates while copying.
func (s *FilesystemStore) Put(ctx context.Context, key string, src io.Reader, maxBytes int64) (domain.PutResult, error) {
	target, err := s.resolve(key)
	if err != nil {
		return domain.PutResult{}, err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
		return domain.PutResult{}, fmt.Errorf("creation: prepare blob shard: %w", err)
	}
	staging, err := os.CreateTemp(filepath.Dir(target), ".upload-")
	if err != nil {
		return domain.PutResult{}, fmt.Errorf("creation: stage blob: %w", err)
	}
	stagingName := staging.Name()
	defer func() {
		staging.Close()
		os.Remove(stagingName)
	}()

	hasher := sha256.New()
	buffer := make([]byte, copyBufferLen)
	var written int64
	for {
		select {
		case <-ctx.Done():
			return domain.PutResult{}, fmt.Errorf("creation: blob upload canceled: %w", ctx.Err())
		default:
		}
		n, readErr := src.Read(buffer)
		if n > 0 {
			chunk := buffer[:n]
			total := written + int64(n)
			if total > maxBytes {
				return domain.PutResult{}, fmt.Errorf("%w: more than %d bytes for %s", domain.ErrTooLarge, maxBytes, key)
			}
			hasher.Write(chunk)
			if _, writeErr := staging.Write(chunk); writeErr != nil {
				return domain.PutResult{}, fmt.Errorf("creation: write blob chunk: %w", writeErr)
			}
			written = total
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			// Cancelation surfacing as a body-level failure still counts as a
			// canceled put, not media damage.
			if ctx.Err() != nil || errors.Is(readErr, context.Canceled) {
				return domain.PutResult{}, fmt.Errorf("creation: blob upload canceled: %w", readErr)
			}
			return domain.PutResult{}, fmt.Errorf("creation: read blob source: %w", readErr)
		}
	}
	if err := staging.Close(); err != nil {
		return domain.PutResult{}, fmt.Errorf("creation: seal staged blob: %w", err)
	}
	if err := os.Chmod(stagingName, 0o640); err != nil {
		return domain.PutResult{}, fmt.Errorf("creation: seal staged blob permissions: %w", err)
	}
	if err := os.Rename(stagingName, target); err != nil {
		return domain.PutResult{}, fmt.Errorf("creation: commit blob: %w", err)
	}
	var sum [32]byte
	copy(sum[:], hasher.Sum(nil))
	return domain.PutResult{ByteSize: written, SHA256Sum: sum}, nil
}

// Open returns a seekable windowed reader plus the whole-blob size; MP4
// probing relies on seeking to box headers near the end of large files
// without buffering them whole.
func (s *FilesystemStore) Open(ctx context.Context, key string, rng domain.BlobRange) (domain.ReadSeekCloser, int64, error) {
	target, err := s.resolve(key)
	if err != nil {
		return nil, 0, err
	}
	file, err := os.Open(target)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, 0, fmt.Errorf("creation: open blob %q: %w", key, os.ErrNotExist)
		}
		return nil, 0, fmt.Errorf("creation: open blob %q: %w", key, err)
	}
	go watchClose(ctx, file)
	window, size, err := newWindowedReader(file, rng)
	if err != nil {
		file.Close()
		return nil, 0, err
	}
	return window, size, nil
}

// Delete removes one blob; an absent key already satisfies cleanup duties.
func (s *FilesystemStore) Delete(_ context.Context, key string) error {
	target, err := s.resolve(key)
	if err != nil {
		return err
	}
	if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("creation: delete blob %q: %w", key, err)
	}
	return nil
}

// watchClose releases the descriptor promptly when a download's request
// context dies mid-stream instead of waiting for GC.
func watchClose(ctx context.Context, closer io.Closer) {
	<-ctx.Done()
	closer.Close()
}

// windowedReader adapts one open file to [start,start+length) with full seek
// support inside the window (and across it — seeks simply reposition).
type windowedReader struct {
	file        *os.File
	start, stop int64 // absolute blob offsets the window covers
	pos         int64 // absolute position; negative length means EOF-open
}

func newWindowedReader(file *os.File, rng domain.BlobRange) (*windowedReader, int64, error) {
	size, err := file.Seek(0, io.SeekEnd)
	if err != nil {
		return nil, 0, fmt.Errorf("creation: probe blob size: %w", err)
	}
	start := clampOffset(rng.Offset, size)
	stop := size
	if rng.Length >= 0 {
		stop = start + rng.Length
		if stop > size {
			stop = size
		}
	}
	pos := start
	if pos > stop {
		pos = stop
	}
	if _, err := file.Seek(pos, io.SeekStart); err != nil {
		return nil, 0, fmt.Errorf("creation: position blob window: %w", err)
	}
	return &windowedReader{file: file, start: start, stop: stop, pos: pos}, size, nil
}

func clampOffset(offset, size int64) int64 {
	if offset < 0 {
		return 0
	}
	if offset > size {
		return size
	}
	return offset
}

func (w *windowedReader) Read(p []byte) (int, error) {
	if w.pos < w.start {
		w.pos = w.start
	}
	remaining := w.stop - w.pos
	if remaining <= 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > remaining {
		p = p[:remaining]
	}
	n, err := w.file.ReadAt(p, w.pos)
	w.pos += int64(n)
	return n, err
}

func (w *windowedReader) Seek(offset int64, whence int) (int64, error) {
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
	w.pos = next
	return w.pos - w.start, nil
}

func (w *windowedReader) Close() error { return w.file.Close() }
