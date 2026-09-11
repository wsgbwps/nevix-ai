package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
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

var knownReferenceErrors = [...]error{
	domain.ErrBlobNotFound,
	domain.ErrObjectStorageUnavailable,
	domain.ErrObjectStorageRateLimited,
	domain.ErrObjectStorageConfiguration,
	domain.ErrInvalidReferenceSource,
	domain.ErrReferenceSourceSizeMismatch,
	domain.ErrReferenceSourceMetadataMismatch,
	domain.ErrReferenceSourceChecksumMismatch,
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
	cleanupObject := func(failure error) {
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
		return domain.ProviderTransferObject{}, safeReferenceSourceError(ctx, err)
	}
	result, putErr := t.store.putProviderTransfer(ctx, key, reader, source.ByteSize, source.MIMEType, metadata)
	closeErr := reader.Close()
	created := putErr == nil
	conflict := errors.Is(putErr, domain.ErrBlobConflict)
	if putErr != nil && !conflict {
		return domain.ProviderTransferObject{}, safeReferenceStorageError(ctx, putErr)
	}
	if closeErr != nil {
		mapped := safeReferenceSourceError(ctx, closeErr)
		if created {
			cleanupObject(mapped)
		}
		return domain.ProviderTransferObject{}, mapped
	}
	if conflict {
		if err := verifyReferenceSourceStream(ctx, source); err != nil {
			return domain.ProviderTransferObject{}, err
		}
		rewritten, err := t.recoverConflictingObject(ctx, key, source, metadata, cleanupObject)
		if err != nil {
			return domain.ProviderTransferObject{}, err
		}
		created = rewritten
	} else if err := validateReferenceSourceFacts(result, source); err != nil {
		cleanupObject(err)
		return domain.ProviderTransferObject{}, err
	}
	info, err := t.store.Head(ctx, key)
	if err != nil {
		mapped := safeReferenceStorageError(ctx, err)
		if created {
			cleanupObject(mapped)
		}
		return domain.ProviderTransferObject{}, mapped
	}
	if err := validateProviderTransferFacts(info, source, metadata); err != nil {
		cleanupObject(err)
		return domain.ProviderTransferObject{}, err
	}
	signedURL, err := t.store.presignGet(ctx, key, domain.ProviderTransferLifetime)
	if err != nil {
		mapped := safeReferenceStorageError(ctx, err)
		if created {
			cleanupObject(mapped)
		}
		return domain.ProviderTransferObject{}, mapped
	}
	return domain.ProviderTransferObject{URL: signedURL}, nil
}

func (t *referenceTransport) recoverConflictingObject(ctx context.Context, key string, source domain.ReferenceSource, metadata map[string]string, cleanupObject func(error)) (bool, error) {
	info, err := t.store.Head(ctx, key)
	if err == nil {
		err = validateProviderTransferFacts(info, source, metadata)
	}
	if err == nil {
		err = t.verifyProviderTransferObject(ctx, key, source)
	}
	if err == nil {
		return false, nil
	}
	err = safeReferenceStorageError(ctx, err)
	if !isHardReferenceFailure(err) {
		return false, err
	}
	if deleteErr := safeReferenceStorageError(ctx, t.store.Delete(ctx, key)); deleteErr != nil {
		return false, deleteErr
	}

	reader, err := source.Open(ctx)
	if err != nil {
		return false, safeReferenceSourceError(ctx, err)
	}
	result, putErr := t.store.putProviderTransfer(ctx, key, reader, source.ByteSize, source.MIMEType, metadata)
	closeErr := reader.Close()
	if putErr != nil {
		return false, safeReferenceStorageError(ctx, putErr)
	}
	if closeErr != nil {
		mapped := safeReferenceSourceError(ctx, closeErr)
		cleanupObject(mapped)
		return false, mapped
	}
	if err := validateReferenceSourceFacts(result, source); err != nil {
		cleanupObject(err)
		return false, err
	}
	return true, nil
}

func (t *referenceTransport) Release(ctx context.Context, providerJobID domain.UUID, ordinal int) error {
	if providerJobID.IsZero() || ordinal < 0 {
		return domain.ErrInvalidReferenceSource
	}
	return safeReferenceStorageError(ctx, t.store.Delete(ctx, providerTransferKey(providerJobID, ordinal)))
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
		return safeReferenceSourceError(ctx, err)
	}
	result, readErr := streamBoundedPut(ctx, reader, source.ByteSize, func(body io.Reader) error {
		_, err := io.Copy(io.Discard, body)
		return err
	})
	closeErr := reader.Close()
	if readErr != nil {
		return safeReferenceSourceError(ctx, readErr)
	}
	if closeErr != nil {
		return safeReferenceSourceError(ctx, closeErr)
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

func validateProviderTransferFacts(info domain.BlobInfo, source domain.ReferenceSource, metadata map[string]string) error {
	if info.ByteSize != source.ByteSize {
		return domain.ErrReferenceSourceSizeMismatch
	}
	if info.ContentType != source.MIMEType || !maps.Equal(info.Metadata, metadata) {
		return domain.ErrReferenceSourceMetadataMismatch
	}
	return nil
}

func (t *referenceTransport) verifyProviderTransferObject(ctx context.Context, key string, source domain.ReferenceSource) error {
	reader, size, err := t.store.Open(ctx, key, domain.FullBlobRange)
	if err != nil {
		return safeReferenceStorageError(ctx, err)
	}
	digest := sha256.New()
	readSize, readErr := copyBoundedReference(digest, reader, source.ByteSize)
	closeErr := reader.Close()
	if readErr != nil {
		return safeReferenceStorageError(ctx, readErr)
	}
	if closeErr != nil {
		return safeReferenceStorageError(ctx, closeErr)
	}
	if size != source.ByteSize || readSize != source.ByteSize {
		return domain.ErrReferenceSourceSizeMismatch
	}
	var sum [32]byte
	copy(sum[:], digest.Sum(nil))
	if sum != source.SHA256Sum {
		return domain.ErrReferenceSourceChecksumMismatch
	}
	return nil
}

func copyBoundedReference(dst hash.Hash, src io.Reader, byteSize int64) (int64, error) {
	return io.CopyBuffer(dst, io.LimitReader(src, byteSize+1), make([]byte, copyBufferLen))
}

func isHardReferenceFailure(err error) bool {
	return errors.Is(err, domain.ErrBlobNotFound) ||
		errors.Is(err, domain.ErrInvalidReferenceSource) ||
		errors.Is(err, domain.ErrReferenceSourceSizeMismatch) ||
		errors.Is(err, domain.ErrReferenceSourceMetadataMismatch) ||
		errors.Is(err, domain.ErrReferenceSourceChecksumMismatch)
}

func safeReferenceStorageError(ctx context.Context, err error) error {
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
	var sourceFailure *sourceReadError
	if errors.As(err, &sourceFailure) {
		return safeReferenceSourceError(ctx, sourceFailure.err)
	}
	if classified, ok := knownReferenceError(err); ok {
		return classified
	}
	return domain.ErrObjectStorageUnavailable
}

func safeReferenceSourceError(ctx context.Context, err error) error {
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
	if classified, ok := knownReferenceError(err); ok {
		return classified
	}
	return domain.ErrInvalidReferenceSource
}

func knownReferenceError(err error) (error, bool) {
	for _, classified := range knownReferenceErrors {
		if errors.Is(err, classified) {
			return classified, true
		}
	}
	return nil, false
}
