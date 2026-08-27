// The single conformance suite both production blob adapters must satisfy
// (filesystem and S3-compatible): streaming put with checksums and hard
// ceilings, whole and windowed reads with correct sizes, seek behavior at
// box-header distances, deletion semantics including absent-key idempotence,
// bounded-buffer cancellation, and prompt resource release after
// cancellation. It lives in this package's test compilation unit (not an
// importable testkit) per the server test-support rules; both adapters'
// tests call runConformanceSuite with their own isolated store factory.
package storage

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// newStoreForTest yields one fresh isolated store per test. Isolation comes
// from each factory choosing its own root/prefix.
type newStoreForTest func(t *testing.T) domain.BlobStore

const (
	smallPayloadLen = 3 << 20 // multi-buffer so conformance exercises chunked copy
	largeMaxBytes   = 8 << 20
	tinyMaxBytes    = 1 << 20
)

func payload(t *testing.T, size int) []byte {
	t.Helper()
	blob := make([]byte, size)
	if _, err := io.ReadFull(rand.Reader, blob); err != nil {
		t.Fatalf("seed payload entropy: %v", err)
	}
	return blob
}

// RunSuite is the shared entrypoint every adapter test calls once.
func runConformanceSuite(t *testing.T, newStore newStoreForTest) {
	t.Run("PutStoresAndCheckSumsBoundedBytes", func(t *testing.T) {
		store := newStore(t)
		ctx := context.Background()
		data := payload(t, smallPayloadLen)
		result, err := store.Put(ctx, "suite/plain", bytes.NewReader(data), largeMaxBytes)
		if err != nil {
			t.Fatalf("put: %v", err)
		}
		if result.ByteSize != int64(len(data)) {
			t.Fatalf("stored %d bytes, want %d", result.ByteSize, len(data))
		}
		if want := sha256.Sum256(data); result.SHA256Sum != want {
			t.Fatal("checksum mismatch")
		}
		reader, size, err := store.Open(ctx, "suite/plain", domain.FullBlobRange)
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		defer reader.Close()
		if size != int64(len(data)) {
			t.Fatalf("reported size %d, want %d", size, len(data))
		}
		back, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("read back: %v", err)
		}
		if !bytes.Equal(back, data) {
			t.Fatal("round trip content mismatch")
		}
	})

	t.Run("PutRejectsOverLimitAndLeavesNoObject", func(t *testing.T) {
		store := newStore(t)
		ctx := context.Background()
		data := payload(t, tinyMaxBytes+1)
		if _, err := store.Put(ctx, "suite/too-big", bytes.NewReader(data), tinyMaxBytes); !errors.Is(err, domain.ErrTooLarge) {
			t.Fatalf("oversize put error = %v, want ErrTooLarge enforced by the adapter", err)
		}
		if _, _, err := store.Open(ctx, "suite/too-big", domain.FullBlobRange); err == nil {
			t.Fatal("rejected upload left an openable object behind")
		}
	})

	t.Run("WindowedReadMatchesRequestedRange", func(t *testing.T) {
		store := newStore(t)
		ctx := context.Background()
		data := payload(t, smallPayloadLen)
		if _, err := store.Put(ctx, "suite/windowed", bytes.NewReader(data), largeMaxBytes); err != nil {
			t.Fatalf("put: %v", err)
		}

		from := int64(1024)
		length := int64(4096)
		reader, wholeSize, err := store.Open(ctx, "suite/windowed", domain.BlobRange{Offset: from, Length: length})
		if err != nil {
			t.Fatalf("open window: %v", err)
		}
		window, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatalf("read window: %v", err)
		}
		if !bytes.Equal(window, data[from:from+length]) {
			t.Fatal("window content mismatch")
		}
		// The reported size stays the whole-blob fact even when a shorter
		// window was requested; Range responses rely on it.
		if wholeSize != int64(len(data)) {
			t.Fatalf("whole-blob size %d, want %d", wholeSize, len(data))
		}
	})

	t.Run("SuffixWindowEndsAtBlobEnd", func(t *testing.T) {
		store := newStore(t)
		ctx := context.Background()
		data := payload(t, 65536)
		if _, err := store.Put(ctx, "suite/suffix", bytes.NewReader(data), largeMaxBytes); err != nil {
			t.Fatalf("put: %v", err)
		}
		start := int64(60000)
		reader, _, err := store.Open(ctx, "suite/suffix", domain.BlobRange{Offset: start, Length: -1})
		if err != nil {
			t.Fatalf("open suffix window: %v", err)
		}
		got, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatalf("read suffix: %v", err)
		}
		if !bytes.Equal(got, data[start:]) {
			t.Fatal("suffix window mismatch")
		}
	})

	t.Run("SeekSupportsBoxHeaderDistancesWithoutDraining", func(t *testing.T) {
		store := newStore(t)
		ctx := context.Background()
		data := payload(t, smallPayloadLen)
		if _, err := store.Put(ctx, "suite/seeky", bytes.NewReader(data), largeMaxBytes); err != nil {
			t.Fatalf("put: %v", err)
		}
		reader, size, err := store.Open(ctx, "suite/seeky", domain.FullBlobRange)
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		defer reader.Close()
		if size != int64(len(data)) {
			t.Fatalf("size %d, want %d", size, len(data))
		}
		end, err := reader.Seek(-8, io.SeekEnd)
		if err != nil || end != int64(len(data)-8) {
			t.Fatalf("seek -8/end: %d %v", end, err)
		}
		head := make([]byte, 8)
		if _, err := io.ReadFull(reader, head); err != nil {
			t.Fatalf("read tail header: %v", err)
		}
		if !bytes.Equal(head, data[len(data)-8:]) {
			t.Fatal("tail-window bytes mismatch after SeekEnd-relative move")
		}
		if _, err := reader.Seek(512, io.SeekStart); err != nil {
			t.Fatalf("seek start: %v", err)
		}
		mid := make([]byte, 16)
		if _, err := io.ReadFull(reader, mid); err != nil {
			t.Fatalf("read middle after seek: %v", err)
		}
		if !bytes.Equal(mid, data[512:528]) {
			t.Fatal("middle bytes mismatch after SeekStart")
		}
	})

	t.Run("DeleteRemovesThenIdempotentOnAbsentKey", func(t *testing.T) {
		store := newStore(t)
		ctx := context.Background()
		data := payload(t, 1024)
		if _, err := store.Put(ctx, "_suite/doomed", bytes.NewReader(data), largeMaxBytes); err != nil {
			t.Fatalf("put: %v", err)
		}
		if err := store.Delete(ctx, "_suite/doomed"); err != nil {
			t.Fatalf("delete: %v", err)
		}
		if _, _, err := store.Open(ctx, "_suite/doomed", domain.FullBlobRange); err == nil {
			t.Fatal("deleted blob still openable")
		}
		if err := store.Delete(ctx, "_suite/doomed"); err != nil {
			t.Fatalf("delete of absent key must succeed, got %v", err)
		}
	})

	t.Run("CanceledPutReturnsPromptlyWithoutObject", func(t *testing.T) {
		store := newStore(t)
		ctx, cancel := context.WithCancel(context.Background())
		slow := io.MultiReader(bytes.NewReader(payload(t, 64<<10)), infiniteZeros{})
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, _ = store.Put(ctx, "suite/canceled-put", slow, largeMaxBytes)
		}()
		time.Sleep(50 * time.Millisecond)
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("canceled put did not return within 5s; buffering is not bounded")
		}
		if _, _, err := store.Open(context.Background(), "suite/canceled-put", domain.FullBlobRange); err == nil {
			t.Fatal("canceled upload left an openable object")
		}
	})
}

// infiniteZeros simulates a producer that never finishes on its own, which
// is what cancellation actually has to interrupt.
type infiniteZeros struct{}

func (infiniteZeros) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 0
	}
	return len(p), nil
}
