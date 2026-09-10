package storage

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"maps"
	"mime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

const (
	providerJobIDMetadataKey    = "provider-job-id"
	referenceOrdinalMetadataKey = "reference-ordinal"
	sha256MetadataKey           = "sha256"
	failedPrepareCleanupTimeout = 10 * time.Second
)

type referenceObjectStore interface {
	domain.DirectUploadBlobStore
	putProviderTransfer(context.Context, string, io.Reader, int64, string, map[string]string) (domain.PutResult, error)
	presignGet(context.Context, string, time.Duration) (string, error)
}

type referenceTransport struct {
	store referenceObjectStore
}

func newReferenceTransport(store referenceObjectStore) *referenceTransport {
	return &referenceTransport{store: store}
}

type prepareCoordinator struct {
	mu     sync.Mutex
	active map[string]chan struct{}
}

// Transfer keys coordinate process-wide because the factory may create multiple adapters.
var providerTransferPrepares = prepareCoordinator{active: make(map[string]chan struct{})}

func (t *referenceTransport) Prepare(ctx context.Context, providerJobID domain.UUID, ordinal int, source domain.ReferenceSource) (domain.ProviderTransferObject, error) {
	if err := validateReferenceSource(providerJobID, ordinal, source); err != nil {
		return domain.ProviderTransferObject{}, err
	}
	key := providerTransferKey(providerJobID, ordinal)
	releasePrepare, err := providerTransferPrepares.acquire(ctx, key)
	if err != nil {
		return domain.ProviderTransferObject{}, err
	}
	releaseOnReturn := true
	defer func() {
		if releaseOnReturn {
			releasePrepare()
		}
	}()
	cleanupCreated := func(failure error) {
		if isCancellation(failure) {
			releaseOnReturn = false
			go func() {
				t.cleanupFailedPrepare(key)
				releasePrepare()
			}()
			return
		}
		t.cleanupFailedPrepare(key)
	}
	metadata := providerTransferMetadata(providerJobID, ordinal, source.SHA256Sum)
	reader, err := source.Open(ctx)
	if err != nil {
		return domain.ProviderTransferObject{}, safeReferenceError(ctx, err)
	}
	result, putErr := t.store.putProviderTransfer(ctx, key, reader, source.ByteSize, source.MIMEType, metadata)
	closeErr := reader.Close()
	created := putErr == nil
	conflict := errors.Is(putErr, domain.ErrBlobConflict)
	if putErr != nil && !conflict {
		return domain.ProviderTransferObject{}, safeReferenceError(ctx, putErr)
	}
	if closeErr != nil {
		mapped := safeReferenceError(ctx, closeErr)
		if created {
			cleanupCreated(mapped)
		}
		return domain.ProviderTransferObject{}, mapped
	}
	if conflict {
		if err := verifyReferenceSourceStream(ctx, source); err != nil {
			return domain.ProviderTransferObject{}, err
		}
	} else if err := validateReferenceSourceFacts(result, source); err != nil {
		cleanupCreated(err)
		return domain.ProviderTransferObject{}, err
	}
	info, err := t.store.Head(ctx, key)
	if err != nil {
		mapped := safeReferenceError(ctx, err)
		if created {
			cleanupCreated(mapped)
		}
		return domain.ProviderTransferObject{}, mapped
	}
	if !providerTransferFactsMatch(info, source, metadata) {
		if created {
			cleanupCreated(domain.ErrObjectStorageUnavailable)
		}
		return domain.ProviderTransferObject{}, domain.ErrObjectStorageUnavailable
	}
	signedURL, err := t.store.presignGet(ctx, key, domain.ProviderTransferLifetime)
	if err != nil {
		mapped := safeReferenceError(ctx, err)
		if created {
			cleanupCreated(mapped)
		}
		return domain.ProviderTransferObject{}, mapped
	}
	return domain.ProviderTransferObject{URL: signedURL}, nil
}

func (t *referenceTransport) Release(ctx context.Context, providerJobID domain.UUID, ordinal int) error {
	if providerJobID.IsZero() || ordinal < 0 {
		return domain.ErrInvalidReferenceSource
	}
	return safeReferenceError(ctx, t.store.Delete(ctx, providerTransferKey(providerJobID, ordinal)))
}

// Same-key prepares serialize so canceled work cannot delete a successor's object.
func (c *prepareCoordinator) acquire(ctx context.Context, key string) (func(), error) {
	for {
		c.mu.Lock()
		active := c.active[key]
		if active == nil {
			done := make(chan struct{})
			c.active[key] = done
			c.mu.Unlock()
			return func() {
				c.mu.Lock()
				if c.active[key] == done {
					delete(c.active, key)
					close(done)
				}
				c.mu.Unlock()
			}, nil
		}
		c.mu.Unlock()
		select {
		case <-active:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func (t *referenceTransport) cleanupFailedPrepare(key string) {
	ctx, cancel := context.WithTimeout(context.Background(), failedPrepareCleanupTimeout)
	defer cancel()
	_ = t.store.Delete(ctx, key)
}

func verifyReferenceSourceStream(ctx context.Context, source domain.ReferenceSource) error {
	reader, err := source.Open(ctx)
	if err != nil {
		return safeReferenceError(ctx, err)
	}
	result, readErr := streamBoundedPut(ctx, reader, source.ByteSize, func(body io.Reader) error {
		_, err := io.Copy(io.Discard, body)
		return err
	})
	closeErr := reader.Close()
	if readErr != nil {
		return safeReferenceError(ctx, readErr)
	}
	if closeErr != nil {
		return safeReferenceError(ctx, closeErr)
	}
	return validateReferenceSourceFacts(result, source)
}

func validateReferenceSourceFacts(result domain.PutResult, source domain.ReferenceSource) error {
	if result.ByteSize != source.ByteSize {
		return domain.ErrReferenceSourceSizeMismatch
	}
	if result.SHA256Sum != source.SHA256Sum {
		return domain.ErrReferenceSourceChecksumMismatch
	}
	return nil
}

func isCancellation(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

func validateReferenceSource(providerJobID domain.UUID, ordinal int, source domain.ReferenceSource) error {
	parsedMIME, params, err := mime.ParseMediaType(source.MIMEType)
	if providerJobID.IsZero() || ordinal < 0 || source.Open == nil || source.ByteSize <= 0 ||
		source.Kind.SizeLimit() == 0 || source.ByteSize > source.Kind.SizeLimit() ||
		!source.Role.AcceptsKind(source.Kind) || err != nil || len(params) != 0 || parsedMIME != source.MIMEType ||
		len(source.MIMEType) > 255 || strings.ContainsAny(source.MIMEType, "\r\n") {
		return domain.ErrInvalidReferenceSource
	}
	return nil
}

func providerTransferKey(providerJobID domain.UUID, ordinal int) string {
	return "provider-transfer/" + providerJobID.String() + "/" + strconv.Itoa(ordinal)
}

func providerTransferMetadata(providerJobID domain.UUID, ordinal int, sum [32]byte) map[string]string {
	return map[string]string{
		providerJobIDMetadataKey:    providerJobID.String(),
		referenceOrdinalMetadataKey: strconv.Itoa(ordinal),
		sha256MetadataKey:           sha256Hex(sum),
	}
}

func sha256Hex(sum [32]byte) string {
	return hex.EncodeToString(sum[:])
}

func providerTransferFactsMatch(info domain.BlobInfo, source domain.ReferenceSource, metadata map[string]string) bool {
	return info.ByteSize == source.ByteSize && info.ContentType == source.MIMEType && maps.Equal(info.Metadata, metadata)
}

func safeReferenceError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	if errors.Is(err, domain.ErrTooLarge) {
		return fmt.Errorf("%w: %w", domain.ErrReferenceSourceSizeMismatch, domain.ErrTooLarge)
	}
	if errors.Is(err, domain.ErrBlobNotFound) {
		return domain.ErrBlobNotFound
	}
	return domain.ErrObjectStorageUnavailable
}
