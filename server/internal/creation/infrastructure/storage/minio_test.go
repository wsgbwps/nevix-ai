package storage

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// minioChunkSize satisfies the provider minimum multipart chunk while
// keeping our own pump buffers at streamBufferLen-sized granularity.
const minioChunkSize uint64 = 64 << 20

// minIOStore is the test-only adapter used by the automated conformance
// harness. Production construction is closed to OSS and COS in factory.go.
type minIOStore struct {
	client *minio.Client
	bucket string
}

func newMinIOStore(ctx context.Context, endpoint, accessKeyID, secretAccessKey, region, bucket string, secure bool) (*minIOStore, error) {
	if endpoint == "" || bucket == "" || accessKeyID == "" || secretAccessKey == "" {
		return nil, errors.New("creation: MinIO test storage requires endpoint, bucket, access key id, and secret access key")
	}
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKeyID, secretAccessKey, ""),
		Secure: secure,
		Region: region,
	})
	if err != nil {
		return nil, fmt.Errorf("creation: build MinIO test client: %w", err)
	}
	if _, err := client.BucketExists(ctx, bucket); err != nil {
		return nil, fmt.Errorf("creation: verify MinIO test bucket %q: %w", bucket, err)
	}
	return &minIOStore{client: client, bucket: bucket}, nil
}

// Put pumps bounded chunks into the provider with exactly one buffer of
// buffering between source and upload stream; the SHA-256 accumulates on
// this side so no extra round trip is spent learning facts about stored
// bytes. Oversize or cancellation seals the pipe with an error, which makes
// minio-go abort its multipart transfer instead of completing silently.
func (s *minIOStore) Put(ctx context.Context, key string, src io.Reader, maxBytes int64) (domain.PutResult, error) {
	pipeReader, pipeWriter := io.Pipe()
	hasher := sha256.New()

	putErr := make(chan error, 1)
	go func() {
		defer close(putErr)
		_, err := s.client.PutObject(ctx, s.bucket, key, pipeReader, -1, minio.PutObjectOptions{PartSize: minioChunkSize})
		if err != nil {
			// The pipe consumer failed or vanished; keep the pump unblocked.
			pipeReader.CloseWithError(err)
			putErr <- err
			return
		}
		putErr <- nil
	}()

	result, copyErr := pumpInto(ctx, src, pipeWriter, maxBytes, hasher)
	var pumpErr error
	switch {
	case copyErr != nil && errors.Is(copyErr, errPumpFailed):
		pumpErr = <-putErr
	case copyErr != nil:
		go drainPutError(putErr)
	default:
		pumpErr = <-putErr
	}

	switch {
	case copyErr != nil && errors.Is(copyErr, domain.ErrTooLarge):
		return domain.PutResult{}, copyErr
	case copyErr != nil || pumpErr != nil:
		return domain.PutResult{}, fmt.Errorf("creation: put blob to MinIO test storage: %w", errors.Join(copyErr, pumpErr))
	}
	return result, nil
}

// Open returns a lazily-seekable reader over one window plus the whole-blob
// size (one HEAD round trip on this adapter).
func (s *minIOStore) Open(ctx context.Context, key string, rng domain.BlobRange) (domain.ReadSeekCloser, int64, error) {
	info, err := s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		errResponse := minio.ToErrorResponse(err)
		if errResponse.Code == "NoSuchKey" {
			return nil, 0, fmt.Errorf("creation: open MinIO test blob %q: %w", key, domain.ErrBlobNotFound)
		}
		return nil, 0, fmt.Errorf("creation: probe blob %q: %w", key, err)
	}
	window, err := newMinIOWindow(ctx, s, key, rng, info.Size)
	if err != nil {
		return nil, 0, err
	}
	return window, info.Size, nil
}

// Delete removes the object; provider-side absence already satisfies cleanup.
func (s *minIOStore) Delete(ctx context.Context, key string) error {
	if err := s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("creation: delete blob %q: %w", key, err)
	}
	return nil
}
