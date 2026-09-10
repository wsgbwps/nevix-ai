//go:build e2e

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"sync"
	"testing"

	"github.com/nevix-ai/server/internal/creation"
	"github.com/nevix-ai/server/internal/identity"
)

func TestMain(m *testing.M) {
	if os.Getenv("NEVIX_E2E_SERVER") == "1" {
		main()
		return
	}
	os.Exit(m.Run())
}

func creationDependencies(identityModule *identity.Module) creation.Deps {
	store := newE2EBlobStore()
	return creation.Deps{
		SessionAuthenticator: identityModule.SessionAuthenticator(),
		ReauthVerifier:       identityModule.ReauthProofs(),
		ObjectStorageVerifier: func(_ context.Context, candidate creation.ObjectStorageCandidate) (creation.ObjectStorageLocation, error) {
			return candidate.Location, nil
		},
		DirectUploadStoreFactory: func(_ creation.ObjectStorageLocation, _ creation.ObjectStorageCredentials) (creation.DirectUploadBlobStore, error) {
			return store, nil
		},
	}
}

type e2eBlobStore struct {
	mu      sync.Mutex
	objects map[string][]byte
}

func newE2EBlobStore() *e2eBlobStore {
	return &e2eBlobStore{objects: map[string][]byte{}}
}

func (s *e2eBlobStore) Put(ctx context.Context, key string, src io.Reader, maxBytes int64) (creation.PutResult, error) {
	if err := ctx.Err(); err != nil {
		return creation.PutResult{}, err
	}
	body, err := io.ReadAll(io.LimitReader(src, maxBytes+1))
	if err != nil {
		return creation.PutResult{}, err
	}
	if int64(len(body)) > maxBytes {
		return creation.PutResult{}, creation.ErrTooLarge
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.objects[key]; exists {
		return creation.PutResult{}, creation.ErrBlobConflict
	}
	s.objects[key] = append([]byte(nil), body...)
	return creation.PutResult{ByteSize: int64(len(body)), SHA256Sum: sha256.Sum256(body)}, nil
}

func (s *e2eBlobStore) Open(ctx context.Context, key string, rng creation.BlobRange) (creation.ReadSeekCloser, int64, error) {
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	s.mu.Lock()
	body, exists := s.objects[key]
	body = append([]byte(nil), body...)
	s.mu.Unlock()
	if !exists {
		return nil, 0, creation.ErrBlobNotFound
	}
	total := int64(len(body))
	if rng.Offset < 0 || rng.Offset > total {
		return nil, 0, creation.ErrRangeNotSatisfiable
	}
	end := total
	if rng.Length >= 0 {
		if rng.Length > total-rng.Offset {
			return nil, 0, creation.ErrRangeNotSatisfiable
		}
		end = rng.Offset + rng.Length
	}
	return e2eReadSeekCloser{Reader: bytes.NewReader(body[rng.Offset:end])}, total, nil
}

func (s *e2eBlobStore) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	delete(s.objects, key)
	s.mu.Unlock()
	return nil
}

func (s *e2eBlobStore) Head(ctx context.Context, key string) (creation.BlobInfo, error) {
	if err := ctx.Err(); err != nil {
		return creation.BlobInfo{}, err
	}
	s.mu.Lock()
	body, exists := s.objects[key]
	s.mu.Unlock()
	if !exists {
		return creation.BlobInfo{}, creation.ErrBlobNotFound
	}
	return creation.BlobInfo{ByteSize: int64(len(body)), Metadata: map[string]string{}}, nil
}

func (*e2eBlobStore) PresignPut(context.Context, creation.PresignPutRequest) (creation.PresignedPut, error) {
	return creation.PresignedPut{}, errors.New("direct uploads are outside the Desktop E2E storage fake")
}

type e2eReadSeekCloser struct {
	*bytes.Reader
}

func (e2eReadSeekCloser) Close() error { return nil }

func TestE2EBlobStorePersistsGeneratedResultsInProcess(t *testing.T) {
	store := newE2EBlobStore()
	want := []byte("generated image")
	put, err := store.Put(context.Background(), "generation-results/result.png", bytes.NewReader(want), int64(len(want)))
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if put.ByteSize != int64(len(want)) {
		t.Fatalf("byte size = %d, want %d", put.ByteSize, len(want))
	}
	reader, total, err := store.Open(context.Background(), "generation-results/result.png", creation.FullBlobRange)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer reader.Close()
	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if total != int64(len(want)) || !bytes.Equal(got, want) {
		t.Fatalf("open = %q total=%d, want %q total=%d", got, total, want, len(want))
	}
}
