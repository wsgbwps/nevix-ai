package storage

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// minioChunkSize satisfies the provider minimum multipart chunk while
// keeping our own pump buffers at streamBufferLen-sized granularity.
const minioChunkSize uint64 = 64 << 20

// S3Store talks to any S3-compatible endpoint (MinIO for tests, customer
// object storage in deployments). Credentials stay inside the Server
// process; Desktop clients only ever see streamed bytes through Go.
type S3Store struct {
	client *minio.Client
	bucket string
}

// NewS3 pins the endpoint settings and proves the bucket exists once at
// construction time so misconfiguration fails at boot, not mid-upload.
func NewS3(ctx context.Context, endpoint, accessKeyID, secretAccessKey, region, bucket string, secure bool) (*S3Store, error) {
	if endpoint == "" || bucket == "" || accessKeyID == "" || secretAccessKey == "" {
		return nil, errors.New("creation: S3 storage requires endpoint, bucket, access key id, and secret access key")
	}
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKeyID, secretAccessKey, ""),
		Secure: secure,
		Region: region,
	})
	if err != nil {
		return nil, fmt.Errorf("creation: build S3 storage client: %w", err)
	}
	if _, err := client.BucketExists(ctx, bucket); err != nil {
		return nil, fmt.Errorf("creation: verify S3 bucket %q: %w", bucket, err)
	}
	return &S3Store{client: client, bucket: bucket}, nil
}

// Put pumps bounded chunks into the provider with exactly one buffer of
// buffering between source and upload stream; the SHA-256 accumulates on
// this side so no extra round trip is spent learning facts about stored
// bytes. Oversize or cancellation seals the pipe with an error, which makes
// minio-go abort its multipart transfer instead of completing silently.
func (s *S3Store) Put(ctx context.Context, key string, src io.Reader, maxBytes int64) (domain.PutResult, error) {
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
		return domain.PutResult{}, fmt.Errorf("creation: put blob to S3: %w", errors.Join(copyErr, pumpErr))
	}
	return result, nil
}

// Open returns a lazily-seekable reader over one window plus the whole-blob
// size (one HEAD round trip on this adapter).
func (s *S3Store) Open(ctx context.Context, key string, rng domain.BlobRange) (domain.ReadSeekCloser, int64, error) {
	info, err := s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		errResponse := minio.ToErrorResponse(err)
		if errResponse.Code == "NoSuchKey" {
			return nil, 0, fmt.Errorf("creation: open blob %q: %w", key, os.ErrNotExist)
		}
		return nil, 0, fmt.Errorf("creation: probe blob %q: %w", key, err)
	}
	window, err := newS3Window(ctx, s, key, rng, info.Size)
	if err != nil {
		return nil, 0, err
	}
	return window, info.Size, nil
}

// Delete removes the object; provider-side absence already satisfies cleanup.
func (s *S3Store) Delete(ctx context.Context, key string) error {
	if err := s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("creation: delete blob %q: %w", key, err)
	}
	return nil
}

// drainPutError keeps a canceled pump from leaking the put goroutine.
func drainPutError(ch chan error) {
	for range ch {
	}
}

// pumpInto copies src into the S3 upload pipe under the same rules the
// filesystem adapter streams by: fixed buffer, periodic cancellation checks,
// hard ceiling, checksum accumulation.
func pumpInto(ctx context.Context, src io.Reader, dst *io.PipeWriter, maxBytes int64, hasher hash.Hash) (domain.PutResult, error) {
	buffer := make([]byte, copyBufferLen)
	var written int64
	fail := func(err error) (domain.PutResult, error) {
		dst.CloseWithError(err)
		return domain.PutResult{}, fmt.Errorf("%w: %v", errPumpFailed, err)
	}
	for {
		select {
		case <-ctx.Done():
			return fail(fmt.Errorf("blob upload canceled: %w", ctx.Err()))
		default:
		}
		n, readErr := src.Read(buffer)
		if n > 0 {
			chunk := buffer[:n]
			total := written + int64(n)
			if total > maxBytes {
				dst.CloseWithError(domain.ErrTooLarge)
				return domain.PutResult{}, fmt.Errorf("%w: more than %d bytes", domain.ErrTooLarge, maxBytes)
			}
			hasher.Write(chunk)
			if _, writeErr := dst.Write(chunk); writeErr != nil {
				return fail(writeErr)
			}
			written = total
		}
		if readErr == io.EOF {
			dst.Close()
			var sum [32]byte
			copy(sum[:], hasher.Sum(nil))
			return domain.PutResult{ByteSize: written, SHA256Sum: sum}, nil
		}
		if readErr != nil {
			if ctx.Err() != nil || errors.Is(readErr, context.Canceled) {
				return fail(fmt.Errorf("blob upload canceled: %w", readErr))
			}
			return fail(readErr)
		}
	}
}

var errPumpFailed = errors.New("pump failed")
