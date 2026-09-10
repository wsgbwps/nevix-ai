package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"maps"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func runReferenceTransportConformanceSuite(t *testing.T, provider Provider, newStore newCloudStoreForTest) {
	t.Helper()

	t.Run("StreamsSourceToDeterministicVerifiedObject", func(t *testing.T) {
		transport, backend := newReferenceTransportForTest(t, provider, newStore)
		data := payload(t, smallPayloadLen)
		digest := sha256.Sum256(data)
		opens, closes, largestRead := 0, 0, 0
		source := domain.ReferenceSource{
			Role:      domain.RoleOmni,
			Kind:      domain.KindVideo,
			MIMEType:  "video/mp4",
			ByteSize:  int64(len(data)),
			SHA256Sum: digest,
			Open: func(context.Context) (io.ReadCloser, error) {
				opens++
				return &observedSource{reader: bytes.NewReader(data), closes: &closes, largestRead: &largestRead}, nil
			},
		}
		jobID := domain.NewUUID()
		_, err := transport.Prepare(context.Background(), jobID, 2, source)
		if err != nil {
			t.Fatalf("Prepare: %v", err)
		}
		if opens != 1 || closes != 1 {
			t.Fatalf("source opens/closes = %d/%d, want 1/1", opens, closes)
		}
		if largestRead > copyBufferLen {
			t.Fatalf("largest source read = %d, want <= %d", largestRead, copyBufferLen)
		}

		wantKey := "provider-transfer/" + jobID.String() + "/2"
		backend.mu.Lock()
		object, exists := backend.objects[wantKey]
		objectCount := len(backend.objects)
		backend.mu.Unlock()
		if !exists || objectCount != 1 {
			t.Fatal("prepared object was not isolated at the deterministic key")
		}
		if object.contentType != source.MIMEType || !bytes.Equal(object.body, data) {
			t.Fatal("prepared object content or MIME does not match the source")
		}
		wantMetadata := map[string]string{
			providerJobIDMetadataKey:    jobID.String(),
			referenceOrdinalMetadataKey: "2",
			sha256MetadataKey:           sha256Hex(digest),
		}
		if !maps.Equal(object.metadata, wantMetadata) {
			t.Fatalf("prepared metadata = %#v, want %#v", object.metadata, wantMetadata)
		}
	})

	t.Run("ReturnsPlainHTTPSGetWithFixedLifetime", func(t *testing.T) {
		transport, backend := newReferenceTransportForTest(t, provider, newStore)
		data := []byte("provider readable reference")
		prepared, err := transport.Prepare(context.Background(), domain.NewUUID(), 0, referenceSource(data))
		if err != nil {
			t.Fatalf("Prepare: %v", err)
		}
		req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, prepared.URL, nil)
		if err != nil {
			t.Fatalf("build signed GET: %v", err)
		}
		response, err := (&http.Client{Transport: backend}).Do(req)
		if err != nil {
			t.Fatalf("signed GET: %v", err)
		}
		got, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if readErr != nil || response.StatusCode != http.StatusOK || !bytes.Equal(got, data) {
			t.Fatalf("signed GET status=%d bytes=%d error=%v", response.StatusCode, len(got), readErr)
		}
		assertSignedLifetime(t, provider, prepared.URL, domain.ProviderTransferLifetime)
	})

	t.Run("RepeatedPrepareRevalidatesWithoutDuplicatingObject", func(t *testing.T) {
		transport, backend := newReferenceTransportForTest(t, provider, newStore)
		data := []byte("immutable reference")
		opens, closes := 0, 0
		source := referenceSource(data)
		source.Open = func(context.Context) (io.ReadCloser, error) {
			opens++
			return &observedSource{reader: bytes.NewReader(data), closes: &closes, largestRead: new(int)}, nil
		}
		jobID := domain.NewUUID()
		if _, err := transport.Prepare(context.Background(), jobID, 0, source); err != nil {
			t.Fatalf("first Prepare: %v", err)
		}
		if _, err := transport.Prepare(context.Background(), jobID, 0, source); err != nil {
			t.Fatalf("repeat Prepare over deterministic object: %v", err)
		}
		if opens != 3 || closes != 3 {
			t.Fatalf("source opens/closes = %d/%d, want 3/3", opens, closes)
		}
		backend.mu.Lock()
		objectCount := len(backend.objects)
		backend.mu.Unlock()
		if objectCount != 1 {
			t.Fatalf("repeat Prepare stored %d objects, want 1", objectCount)
		}
	})

	t.Run("ReleaseDeletesExactObjectIdempotently", func(t *testing.T) {
		transport, backend := newReferenceTransportForTest(t, provider, newStore)
		jobID := domain.NewUUID()
		if _, err := transport.Prepare(context.Background(), jobID, 2, referenceSource([]byte("release me"))); err != nil {
			t.Fatalf("Prepare: %v", err)
		}
		if _, err := transport.Prepare(context.Background(), jobID, 3, referenceSource([]byte("keep me"))); err != nil {
			t.Fatalf("Prepare adjacent object: %v", err)
		}
		if err := transport.Release(context.Background(), jobID, 2); err != nil {
			t.Fatalf("Release: %v", err)
		}
		if err := transport.Release(context.Background(), jobID, 2); err != nil {
			t.Fatalf("idempotent Release: %v", err)
		}
		backend.mu.Lock()
		remaining := len(backend.objects)
		_, adjacentExists := backend.objects["provider-transfer/"+jobID.String()+"/3"]
		backend.mu.Unlock()
		if remaining != 1 || !adjacentExists {
			t.Fatalf("Release left %d objects or removed the adjacent ordinal", remaining)
		}
	})

	t.Run("RejectsMutatedSourceOnConflictRetry", func(t *testing.T) {
		transport, backend := newReferenceTransportForTest(t, provider, newStore)
		original := []byte("original")
		mutated := []byte("mutated!")
		opens := 0
		source := referenceSource(original)
		source.Open = func(context.Context) (io.ReadCloser, error) {
			opens++
			data := original
			if opens > 1 {
				data = mutated
			}
			return io.NopCloser(bytes.NewReader(data)), nil
		}
		jobID := domain.NewUUID()
		if _, err := transport.Prepare(context.Background(), jobID, 0, source); err != nil {
			t.Fatalf("first Prepare: %v", err)
		}
		if _, err := transport.Prepare(context.Background(), jobID, 0, source); !errors.Is(err, domain.ErrReferenceSourceChecksumMismatch) {
			t.Fatalf("mutated retry error = %v, want ErrReferenceSourceChecksumMismatch", err)
		}
		backend.mu.Lock()
		stored := backend.objects["provider-transfer/"+jobID.String()+"/0"].body
		backend.mu.Unlock()
		if !bytes.Equal(stored, original) {
			t.Fatal("conflict retry changed the existing object")
		}
	})

	t.Run("RejectsInvalidSourceBeforeOpening", func(t *testing.T) {
		transport, backend := newReferenceTransportForTest(t, provider, newStore)
		data := []byte("source")
		digest := sha256.Sum256(data)
		valid := domain.ReferenceSource{
			Role: domain.RoleReference, Kind: domain.KindImage, MIMEType: "image/png",
			ByteSize: int64(len(data)), SHA256Sum: digest,
			Open: func(context.Context) (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(data)), nil },
		}
		zeroJobID := domain.UUID{}
		tests := []struct {
			name    string
			jobID   domain.UUID
			ordinal int
			mutate  func(*domain.ReferenceSource)
		}{
			{name: "zero job", jobID: zeroJobID},
			{name: "negative ordinal", jobID: domain.NewUUID(), ordinal: -1},
			{name: "missing open", jobID: domain.NewUUID(), mutate: func(s *domain.ReferenceSource) { s.Open = nil }},
			{name: "role kind mismatch", jobID: domain.NewUUID(), mutate: func(s *domain.ReferenceSource) { s.Kind = domain.KindVideo }},
			{name: "kind limit", jobID: domain.NewUUID(), mutate: func(s *domain.ReferenceSource) { s.ByteSize = domain.ImageMaxBytes + 1 }},
			{name: "non canonical mime", jobID: domain.NewUUID(), mutate: func(s *domain.ReferenceSource) { s.MIMEType = "image/png; charset=utf-8" }},
		}
		for _, tc := range tests {
			t.Run(tc.name, func(t *testing.T) {
				source := valid
				if tc.mutate != nil {
					tc.mutate(&source)
				}
				opens := 0
				sourceOpen := source.Open
				if sourceOpen != nil {
					source.Open = func(ctx context.Context) (io.ReadCloser, error) {
						opens++
						return sourceOpen(ctx)
					}
				}
				if _, err := transport.Prepare(context.Background(), tc.jobID, tc.ordinal, source); !errors.Is(err, domain.ErrInvalidReferenceSource) {
					t.Fatalf("Prepare error = %v, want ErrInvalidReferenceSource", err)
				}
				if opens != 0 {
					t.Fatalf("invalid source opened %d times", opens)
				}
			})
		}
		backend.mu.Lock()
		objectCount := len(backend.objects)
		backend.mu.Unlock()
		if objectCount != 0 {
			t.Fatalf("invalid sources stored %d objects", objectCount)
		}
	})

	t.Run("RejectsChangedSourceBytesAndCleansCreatedObjects", func(t *testing.T) {
		tests := []struct {
			name     string
			declared []byte
			actual   io.Reader
			want     error
		}{
			{name: "larger", declared: []byte("short"), actual: strings.NewReader("longer"), want: domain.ErrReferenceSourceSizeMismatch},
			{name: "smaller", declared: []byte("longer"), actual: strings.NewReader("short"), want: domain.ErrReferenceSourceSizeMismatch},
			{name: "checksum", declared: []byte("right"), actual: strings.NewReader("wrong"), want: domain.ErrReferenceSourceChecksumMismatch},
			{name: "read failure", declared: []byte("right"), actual: io.MultiReader(strings.NewReader("ri"), errorReader{}), want: domain.ErrObjectStorageUnavailable},
		}
		for _, tc := range tests {
			t.Run(tc.name, func(t *testing.T) {
				transport, backend := newReferenceTransportForTest(t, provider, newStore)
				digest := sha256.Sum256(tc.declared)
				closes := 0
				source := domain.ReferenceSource{
					Role: domain.RoleReference, Kind: domain.KindImage, MIMEType: "image/png",
					ByteSize: int64(len(tc.declared)), SHA256Sum: digest,
					Open: func(context.Context) (io.ReadCloser, error) {
						return &observedSource{reader: tc.actual, closes: &closes, largestRead: new(int)}, nil
					},
				}
				_, err := transport.Prepare(context.Background(), domain.NewUUID(), 0, source)
				if !errors.Is(err, tc.want) {
					t.Fatalf("Prepare error = %v, want %v", err, tc.want)
				}
				if closes != 1 {
					t.Fatalf("source closes = %d, want 1", closes)
				}
				backend.mu.Lock()
				remaining := len(backend.objects)
				backend.mu.Unlock()
				if remaining != 0 {
					t.Fatalf("failed Prepare left %d objects", remaining)
				}
				if strings.Contains(err.Error(), errorReaderSecret) {
					t.Fatalf("source detail leaked in error: %v", err)
				}
			})
		}
	})

	t.Run("SanitizesSourceOpenFailureWithoutWriting", func(t *testing.T) {
		transport, backend := newReferenceTransportForTest(t, provider, newStore)
		source := domain.ReferenceSource{
			Role: domain.RoleReference, Kind: domain.KindImage, MIMEType: "image/png", ByteSize: 1,
			SHA256Sum: sha256.Sum256([]byte{0}),
			Open: func(context.Context) (io.ReadCloser, error) {
				return nil, errors.New(errorReaderSecret)
			},
		}
		_, err := transport.Prepare(context.Background(), domain.NewUUID(), 0, source)
		if !errors.Is(err, domain.ErrObjectStorageUnavailable) || strings.Contains(err.Error(), errorReaderSecret) {
			t.Fatalf("Prepare error = %v, want sanitized ErrObjectStorageUnavailable", err)
		}
		backend.mu.Lock()
		remaining := len(backend.objects)
		backend.mu.Unlock()
		if remaining != 0 {
			t.Fatalf("Open failure stored %d objects", remaining)
		}
	})

	t.Run("RejectsUnverifiedTargetFactsAndCleans", func(t *testing.T) {
		tests := []struct {
			name   string
			mutate func(*fakeCloudTransport)
		}{
			{name: "size", mutate: func(f *fakeCloudTransport) { f.headSizeDelta = 1 }},
			{name: "mime", mutate: func(f *fakeCloudTransport) { f.headContentType = "application/octet-stream" }},
			{name: "metadata", mutate: func(f *fakeCloudTransport) { f.omitMetadata = sha256MetadataKey }},
		}
		for _, tc := range tests {
			t.Run(tc.name, func(t *testing.T) {
				transport, backend := newReferenceTransportForTest(t, provider, newStore)
				tc.mutate(backend)
				data := []byte("verified bytes")
				digest := sha256.Sum256(data)
				source := domain.ReferenceSource{
					Role: domain.RoleReference, Kind: domain.KindImage, MIMEType: "image/png",
					ByteSize: int64(len(data)), SHA256Sum: digest,
					Open: func(context.Context) (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(data)), nil },
				}
				if _, err := transport.Prepare(context.Background(), domain.NewUUID(), 0, source); !errors.Is(err, domain.ErrObjectStorageUnavailable) {
					t.Fatalf("Prepare error = %v, want ErrObjectStorageUnavailable", err)
				}
				backend.mu.Lock()
				remaining := len(backend.objects)
				backend.mu.Unlock()
				if remaining != 0 {
					t.Fatalf("failed target verification left %d objects", remaining)
				}
			})
		}
	})

	t.Run("CancellationStopsTransferAndClosesSource", func(t *testing.T) {
		transport, backend := newReferenceTransportForTest(t, provider, newStore)
		ctx, cancel := context.WithCancel(context.Background())
		closes := 0
		source := domain.ReferenceSource{
			Role: domain.RoleOmni, Kind: domain.KindVideo, MIMEType: "video/mp4",
			ByteSize: domain.VideoMaxBytes, SHA256Sum: sha256.Sum256(nil),
			Open: func(context.Context) (io.ReadCloser, error) {
				return &observedSource{reader: slowZeros{}, closes: &closes, largestRead: new(int)}, nil
			},
		}
		done := make(chan error, 1)
		go func() {
			_, err := transport.Prepare(ctx, domain.NewUUID(), 0, source)
			done <- err
		}()
		time.Sleep(50 * time.Millisecond)
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("Prepare error = %v, want context.Canceled", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("canceled Prepare did not return")
		}
		if closes != 1 {
			t.Fatalf("source closes = %d, want 1", closes)
		}
		backend.mu.Lock()
		remaining := len(backend.objects)
		backend.mu.Unlock()
		if remaining != 0 {
			t.Fatalf("canceled Prepare left %d objects", remaining)
		}
	})

	t.Run("CancellationDuringVerificationReturnsPromptly", func(t *testing.T) {
		transport, backend := newReferenceTransportForTest(t, provider, newStore)
		ctx, cancel := context.WithCancel(context.Background())
		deleteGate := make(chan struct{})
		deleteGateClosed := false
		defer func() {
			if !deleteGateClosed {
				close(deleteGate)
			}
		}()
		backend.cancelOnHead = cancel
		backend.deleteGate = deleteGate

		done := make(chan error, 1)
		go func() {
			_, err := transport.Prepare(ctx, domain.NewUUID(), 0, referenceSource([]byte("cancel after upload")))
			done <- err
		}()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("Prepare error = %v, want context.Canceled", err)
			}
		case <-time.After(time.Second):
			t.Fatal("canceled verification waited for cleanup")
		}

		close(deleteGate)
		deleteGateClosed = true
		deadline := time.Now().Add(time.Second)
		for {
			backend.mu.Lock()
			remaining := len(backend.objects)
			backend.mu.Unlock()
			if remaining == 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("asynchronous cleanup left %d objects", remaining)
			}
			time.Sleep(10 * time.Millisecond)
		}
	})

	t.Run("RetryWaitsForCanceledPrepareCleanup", func(t *testing.T) {
		transport, backend := newReferenceTransportForTest(t, provider, newStore)
		assertRetryWaitsForCanceledPrepareCleanup(t, transport, transport, backend)
	})

	t.Run("RetryAcrossTransportInstancesWaitsForCanceledPrepareCleanup", func(t *testing.T) {
		backend := newFakeCloudTransport(provider)
		first := newReferenceTransport(newStore(t, backend).(referenceObjectStore))
		retry := newReferenceTransport(newStore(t, backend).(referenceObjectStore))
		assertRetryWaitsForCanceledPrepareCleanup(t, first, retry, backend)
	})

	t.Run("SanitizesProviderFailures", func(t *testing.T) {
		transport, backend := newReferenceTransportForTest(t, provider, newStore)
		backend.failMethod = http.MethodPut
		data := []byte("private source bytes")
		digest := sha256.Sum256(data)
		source := domain.ReferenceSource{
			Role: domain.RoleReference, Kind: domain.KindImage, MIMEType: "image/png",
			ByteSize: int64(len(data)), SHA256Sum: digest,
			Open: func(context.Context) (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(data)), nil },
		}
		jobID := domain.NewUUID()
		_, err := transport.Prepare(context.Background(), jobID, 7, source)
		if !errors.Is(err, domain.ErrObjectStorageUnavailable) {
			t.Fatalf("Prepare error = %v, want ErrObjectStorageUnavailable", err)
		}
		for _, secret := range []string{fakeSensitiveProviderMessage, jobID.String(), "provider-transfer/", string(data), "test-ak", "test-sk"} {
			if strings.Contains(err.Error(), secret) {
				t.Fatal("sensitive value leaked in error")
			}
		}
	})
}

type observedSource struct {
	reader      io.Reader
	closes      *int
	largestRead *int
}

func (s *observedSource) Read(p []byte) (int, error) {
	if len(p) > *s.largestRead {
		*s.largestRead = len(p)
	}
	return s.reader.Read(p)
}

func newReferenceTransportForTest(t *testing.T, provider Provider, newStore newCloudStoreForTest) (domain.ReferenceTransport, *fakeCloudTransport) {
	t.Helper()
	backend := newFakeCloudTransport(provider)
	store := newStore(t, backend)
	return newReferenceTransport(store.(referenceObjectStore)), backend
}

func assertRetryWaitsForCanceledPrepareCleanup(t *testing.T, first, retry domain.ReferenceTransport, backend *fakeCloudTransport) {
	t.Helper()
	jobID := domain.NewUUID()
	ctx, cancel := context.WithCancel(context.Background())
	deleteGate := make(chan struct{})
	deleteGateClosed := false
	defer func() {
		if !deleteGateClosed {
			close(deleteGate)
		}
	}()
	backend.cancelOnHead = cancel
	backend.deleteGate = deleteGate
	if _, err := first.Prepare(ctx, jobID, 0, referenceSource([]byte("stable retry"))); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled Prepare error = %v, want context.Canceled", err)
	}

	retryDone := make(chan struct {
		prepared domain.ProviderTransferObject
		err      error
	}, 1)
	go func() {
		prepared, err := retry.Prepare(context.Background(), jobID, 0, referenceSource([]byte("stable retry")))
		retryDone <- struct {
			prepared domain.ProviderTransferObject
			err      error
		}{prepared: prepared, err: err}
	}()
	select {
	case result := <-retryDone:
		t.Fatalf("retry completed before canceled Prepare cleanup: %v", result.err)
	case <-time.After(100 * time.Millisecond):
	}

	close(deleteGate)
	deleteGateClosed = true
	select {
	case result := <-retryDone:
		if result.err != nil {
			t.Fatalf("retry Prepare: %v", result.err)
		}
		response, err := (&http.Client{Transport: backend}).Get(result.prepared.URL)
		if err != nil {
			t.Fatalf("GET retried transfer: %v", err)
		}
		body, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if readErr != nil || response.StatusCode != http.StatusOK || string(body) != "stable retry" {
			t.Fatalf("retried GET status=%d body=%q error=%v", response.StatusCode, body, readErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("retry did not resume after canceled Prepare cleanup")
	}
}

func assertSignedLifetime(t *testing.T, provider Provider, rawURL string, want time.Duration) {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		t.Fatal("prepared URL is not a plain public HTTPS authority")
	}
	var seconds int64
	if provider == ProviderOSS {
		seconds, err = strconv.ParseInt(parsed.Query().Get("x-oss-expires"), 10, 64)
	} else {
		parts := strings.Split(parsed.Query().Get("q-sign-time"), ";")
		if len(parts) != 2 {
			t.Fatal("COS signed URL lacks a bounded sign window")
		}
		start, startErr := strconv.ParseInt(parts[0], 10, 64)
		end, endErr := strconv.ParseInt(parts[1], 10, 64)
		if startErr != nil || endErr != nil {
			t.Fatal("COS signed URL has an invalid sign window")
		}
		seconds = end - start
	}
	if err != nil || time.Duration(seconds)*time.Second != want {
		t.Fatalf("signed lifetime = %s, want %s", time.Duration(seconds)*time.Second, want)
	}
}

const errorReaderSecret = "permanent-key-secret"

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) {
	return 0, errors.New(errorReaderSecret)
}

func (s *observedSource) Close() error {
	(*s.closes)++
	return nil
}

func referenceSource(data []byte) domain.ReferenceSource {
	return domain.ReferenceSource{
		Role:      domain.RoleReference,
		Kind:      domain.KindImage,
		MIMEType:  "image/png",
		ByteSize:  int64(len(data)),
		SHA256Sum: sha256.Sum256(data),
		Open: func(context.Context) (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(data)), nil
		},
	}
}
