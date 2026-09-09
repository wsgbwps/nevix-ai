package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"hash/crc64"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

type newCloudStoreForTest func(t *testing.T, transport http.RoundTripper) domain.DirectUploadBlobStore

func runCloudConformanceSuite(t *testing.T, provider Provider, newStore newCloudStoreForTest) {
	t.Helper()

	t.Run("BlobStore", func(t *testing.T) {
		backend := newFakeCloudTransport(provider)
		runConformanceSuite(t, func(t *testing.T) domain.BlobStore {
			t.Helper()
			return newStore(t, backend)
		})
	})

	t.Run("HeadReportsAuthoritativeFacts", func(t *testing.T) {
		backend := newFakeCloudTransport(provider)
		store := newStore(t, backend)
		ctx := context.Background()
		if _, err := store.Put(ctx, "suite/head", strings.NewReader("hello"), 1024); err != nil {
			t.Fatalf("Put: %v", err)
		}
		info, err := store.Head(ctx, "suite/head")
		if err != nil {
			t.Fatalf("Head: %v", err)
		}
		if info.ByteSize != 5 {
			t.Fatalf("Head byte size = %d, want 5", info.ByteSize)
		}
	})

	t.Run("PutForbidsOverwrite", func(t *testing.T) {
		backend := newFakeCloudTransport(provider)
		store := newStore(t, backend)
		ctx := context.Background()
		if _, err := store.Put(ctx, "suite/no-overwrite", strings.NewReader("first"), 1024); err != nil {
			t.Fatalf("first Put: %v", err)
		}
		if _, err := store.Put(ctx, "suite/no-overwrite", strings.NewReader("second"), 1024); !errors.Is(err, domain.ErrBlobConflict) {
			t.Fatalf("second Put error = %v, want ErrBlobConflict", err)
		}
	})

	t.Run("CanceledPutNeverDeletesAnExistingObject", func(t *testing.T) {
		backend := newFakeCloudTransport(provider)
		store := newStore(t, backend)
		ctx := context.Background()
		if _, err := store.Put(ctx, "suite/cancel-existing", strings.NewReader("original"), 1024); err != nil {
			t.Fatalf("first Put: %v", err)
		}
		canceled, cancel := context.WithCancel(ctx)
		cancel()
		if _, err := store.Put(canceled, "suite/cancel-existing", strings.NewReader("replacement"), 1024); !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled Put error = %v, want context.Canceled", err)
		}
		reader, _, err := store.Open(ctx, "suite/cancel-existing", domain.FullBlobRange)
		if err != nil {
			t.Fatalf("Open existing object: %v", err)
		}
		defer reader.Close()
		body, err := io.ReadAll(reader)
		if err != nil || string(body) != "original" {
			t.Fatalf("existing body = %q, error = %v", body, err)
		}
	})

	t.Run("PresignedPutSignsOnlyRequiredHeaders", func(t *testing.T) {
		backend := newFakeCloudTransport(provider)
		store := newStore(t, backend)
		ctx := context.Background()
		signed, err := store.PresignPut(ctx, domain.PresignPutRequest{
			Key:         "suite/direct-upload",
			ContentType: "image/png",
			UploadID:    "upload-123",
			ExpiresIn:   time.Hour,
		})
		if err != nil {
			t.Fatalf("PresignPut: %v", err)
		}
		parsed, err := url.Parse(signed.URL)
		if err != nil {
			t.Fatalf("parse signed URL: %v", err)
		}
		if got := parsed.Scheme + "://" + parsed.Host; got != backend.origin() {
			t.Fatalf("signed origin = %q, want %q", got, backend.origin())
		}
		wantHeaders := map[string]string{
			"Content-Type":                  "image/png",
			backend.metadataHeaderName():    "upload-123",
			backend.forbidOverwriteHeader(): "true",
		}
		if !sameHeaders(signed.Headers, wantHeaders) {
			t.Fatalf("signed headers = %#v, want %#v", signed.Headers, wantHeaders)
		}
		for _, forbidden := range []string{"Content-Md5", "Content-Length"} {
			if _, ok := signed.Headers[forbidden]; ok {
				t.Fatalf("presign must not require %s", forbidden)
			}
		}

		put := func(body string) int {
			req, err := http.NewRequestWithContext(ctx, signed.Method, signed.URL, strings.NewReader(body))
			if err != nil {
				t.Fatalf("build signed PUT: %v", err)
			}
			for name, value := range signed.Headers {
				req.Header.Set(name, value)
			}
			resp, err := (&http.Client{Transport: backend}).Do(req)
			if err != nil {
				t.Fatalf("signed PUT: %v", err)
			}
			resp.Body.Close()
			return resp.StatusCode
		}
		if status := put("signed bytes"); status != http.StatusOK {
			t.Fatalf("first signed PUT status = %d", status)
		}
		if status := put("overwrite"); status != http.StatusConflict {
			t.Fatalf("second signed PUT status = %d, want conflict", status)
		}

		info, err := store.Head(ctx, "suite/direct-upload")
		if err != nil {
			t.Fatalf("Head signed object: %v", err)
		}
		if info.ContentType != "image/png" || info.Metadata[domain.UploadIDMetadataKey] != "upload-123" {
			t.Fatalf("signed object facts = %#v", info)
		}
	})

	t.Run("MapsProviderErrorsWithoutLeakingResponses", func(t *testing.T) {
		backend := newFakeCloudTransport(provider)
		store := newStore(t, backend)
		_, err := store.Head(context.Background(), fakeProviderErrorKey)
		if !errors.Is(err, domain.ErrObjectStorageUnavailable) {
			t.Fatalf("Head error = %v, want ErrObjectStorageUnavailable", err)
		}
		if strings.Contains(err.Error(), fakeSensitiveProviderMessage) {
			t.Fatalf("provider response leaked in error: %v", err)
		}
	})

	t.Run("DoesNotMisclassifyBucketOrUnrelatedConflictErrors", func(t *testing.T) {
		backend := newFakeCloudTransport(provider)
		store := newStore(t, backend)
		for _, key := range []string{fakeMissingBucketKey, fakeUnrelatedConflictKey} {
			_, err := store.Head(context.Background(), key)
			if !errors.Is(err, domain.ErrObjectStorageUnavailable) {
				t.Fatalf("Head(%q) error = %v, want ErrObjectStorageUnavailable", key, err)
			}
			if errors.Is(err, domain.ErrBlobNotFound) || errors.Is(err, domain.ErrBlobConflict) {
				t.Fatalf("Head(%q) misclassified provider error: %v", key, err)
			}
			if strings.Contains(err.Error(), fakeSensitiveProviderMessage) {
				t.Fatalf("Head(%q) leaked provider response: %v", key, err)
			}
		}
	})

	if provider == ProviderCOS {
		t.Run("DisambiguatesCodeLessHeadNotFound", func(t *testing.T) {
			backend := newFakeCloudTransport(provider)
			store := newStore(t, backend)
			if _, err := store.Head(context.Background(), fakeCodeLessMissingKey); !errors.Is(err, domain.ErrBlobNotFound) {
				t.Fatalf("missing key error = %v, want ErrBlobNotFound", err)
			}
			if _, err := store.Head(context.Background(), fakeCodeLessMissingBucket); !errors.Is(err, domain.ErrObjectStorageUnavailable) {
				t.Fatalf("missing bucket error = %v, want ErrObjectStorageUnavailable", err)
			}
		})
	}
}

func sameHeaders(got, want map[string]string) bool {
	if len(got) != len(want) {
		return false
	}
	canonical := make(map[string]string, len(got))
	for name, value := range got {
		canonical[http.CanonicalHeaderKey(name)] = value
	}
	for name, value := range want {
		if canonical[http.CanonicalHeaderKey(name)] != value {
			return false
		}
	}
	return true
}

const (
	fakeProviderErrorKey         = "suite/provider-error"
	fakeMissingBucketKey         = "suite/missing-bucket"
	fakeUnrelatedConflictKey     = "suite/unrelated-conflict"
	fakeCodeLessMissingKey       = "suite/codeless-missing-key"
	fakeCodeLessMissingBucket    = "suite/codeless-missing-bucket"
	fakeSensitiveProviderMessage = "credential-secret-from-provider"
)

type fakeCloudObject struct {
	body        []byte
	contentType string
	uploadID    string
}

type fakeCloudTransport struct {
	provider               Provider
	mu                     sync.Mutex
	objects                map[string]fakeCloudObject
	last                   http.Header
	methods                map[string]int
	failMethod             string
	sawAnonymousGet        bool
	sawOriginNullPreflight bool
	sawRangeGet            bool
}

func newFakeCloudTransport(provider Provider) *fakeCloudTransport {
	return &fakeCloudTransport{provider: provider, objects: make(map[string]fakeCloudObject), methods: make(map[string]int)}
}

func (f *fakeCloudTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := req.Context().Err(); err != nil {
		return nil, err
	}
	key, err := url.PathUnescape(strings.TrimPrefix(req.URL.EscapedPath(), "/"))
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	f.methods[req.Method]++
	if req.Method == http.MethodOptions && req.Header.Get("Origin") == "null" {
		f.sawOriginNullPreflight = true
		headers := make(http.Header)
		headers.Set("Access-Control-Allow-Origin", "null")
		headers.Set("Access-Control-Allow-Methods", http.MethodPut)
		headers.Set("Access-Control-Allow-Headers", req.Header.Get("Access-Control-Request-Headers"))
		f.mu.Unlock()
		return f.response(req, http.StatusNoContent, headers, nil), nil
	}
	if req.Method == f.failMethod {
		f.mu.Unlock()
		return f.errorResponse(req, http.StatusServiceUnavailable, "ServiceUnavailable", fakeSensitiveProviderMessage), nil
	}
	f.mu.Unlock()
	switch key {
	case fakeProviderErrorKey:
		return f.errorResponse(req, http.StatusServiceUnavailable, "ServiceUnavailable", fakeSensitiveProviderMessage), nil
	case fakeMissingBucketKey:
		return f.errorResponse(req, http.StatusNotFound, "NoSuchBucket", fakeSensitiveProviderMessage), nil
	case fakeUnrelatedConflictKey:
		return f.errorResponse(req, http.StatusConflict, f.unrelatedConflictCode(), fakeSensitiveProviderMessage), nil
	case fakeCodeLessMissingKey:
		if req.Method == http.MethodHead {
			return f.response(req, http.StatusNotFound, nil, nil), nil
		}
		return f.errorResponse(req, http.StatusNotFound, "NoSuchKey", fakeSensitiveProviderMessage), nil
	case fakeCodeLessMissingBucket:
		if req.Method == http.MethodHead {
			return f.response(req, http.StatusNotFound, nil, nil), nil
		}
		return f.errorResponse(req, http.StatusNotFound, "NoSuchBucket", fakeSensitiveProviderMessage), nil
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	f.last = req.Header.Clone()
	switch req.Method {
	case http.MethodPut:
		if req.Header.Get(f.forbidOverwriteHeader()) != "true" {
			return f.errorResponse(req, http.StatusBadRequest, "InvalidRequest", "missing overwrite guard"), nil
		}
		if _, exists := f.objects[key]; exists {
			return f.errorResponse(req, http.StatusConflict, "FileAlreadyExists", "object exists"), nil
		}
		body, readErr := io.ReadAll(req.Body)
		if readErr != nil {
			return nil, readErr
		}
		f.objects[key] = fakeCloudObject{
			body:        body,
			contentType: req.Header.Get("Content-Type"),
			uploadID:    req.Header.Get(f.metadataHeaderName()),
		}
		headers := make(http.Header)
		if f.provider == ProviderCOS {
			checksum := crc64.Checksum(body, crc64.MakeTable(crc64.ECMA))
			headers.Set("x-cos-hash-crc64ecma", strconv.FormatUint(checksum, 10))
		}
		return f.response(req, http.StatusOK, headers, nil), nil
	case http.MethodHead:
		object, exists := f.objects[key]
		if !exists {
			return f.errorResponse(req, http.StatusNotFound, "NoSuchKey", "missing"), nil
		}
		headers := make(http.Header)
		headers.Set("Content-Length", strconv.Itoa(len(object.body)))
		headers.Set("Content-Type", object.contentType)
		headers.Set(f.metadataHeaderName(), object.uploadID)
		return f.response(req, http.StatusOK, headers, nil), nil
	case http.MethodGet:
		if req.Header.Get("Authorization") == "" && req.URL.Query().Get("x-oss-signature") == "" && req.URL.Query().Get("q-signature") == "" {
			f.sawAnonymousGet = true
			return f.errorResponse(req, http.StatusForbidden, "AccessDenied", "private"), nil
		}
		if req.Header.Get("Range") != "" {
			f.sawRangeGet = true
		}
		object, exists := f.objects[key]
		if !exists {
			return f.errorResponse(req, http.StatusNotFound, "NoSuchKey", "missing"), nil
		}
		body, status, headers, rangeErr := fakeRange(object.body, req.Header.Get("Range"))
		if rangeErr != nil {
			return f.errorResponse(req, http.StatusRequestedRangeNotSatisfiable, "InvalidRange", "invalid range"), nil
		}
		return f.response(req, status, headers, body), nil
	case http.MethodDelete:
		delete(f.objects, key)
		return f.response(req, http.StatusNoContent, nil, nil), nil
	default:
		return nil, fmt.Errorf("unexpected cloud control-plane or list request: %s %s", req.Method, req.URL)
	}
}

func (f *fakeCloudTransport) sawMethod(method string) bool {
	return f.methods[method] > 0
}

func (f *fakeCloudTransport) unrelatedConflictCode() string {
	if f.provider == ProviderOSS {
		return "FileImmutable"
	}
	return "ObjectLocked"
}

func (f *fakeCloudTransport) origin() string {
	if f.provider == ProviderOSS {
		return "https://nevix-test.oss-cn-hangzhou.aliyuncs.com"
	}
	return "https://nevix-test-1250000000.cos.ap-shanghai.myqcloud.com"
}

func (f *fakeCloudTransport) forbidOverwriteHeader() string {
	if f.provider == ProviderOSS {
		return "x-oss-forbid-overwrite"
	}
	return "x-cos-forbid-overwrite"
}

func (f *fakeCloudTransport) metadataHeaderName() string {
	if f.provider == ProviderOSS {
		return "x-oss-meta-" + domain.UploadIDMetadataKey
	}
	return "x-cos-meta-" + domain.UploadIDMetadataKey
}

func (f *fakeCloudTransport) response(req *http.Request, status int, headers http.Header, body []byte) *http.Response {
	if headers == nil {
		headers = make(http.Header)
	}
	return &http.Response{
		StatusCode: status,
		Status:     strconv.Itoa(status) + " " + http.StatusText(status),
		Header:     headers,
		Body:       io.NopCloser(bytes.NewReader(body)),
		Request:    req,
	}
}

func (f *fakeCloudTransport) errorResponse(req *http.Request, status int, code, message string) *http.Response {
	body := []byte("<Error><Code>" + code + "</Code><Message>" + message + "</Message><RequestId>fake</RequestId></Error>")
	return f.response(req, status, http.Header{"Content-Type": []string{"application/xml"}}, body)
}

func fakeRange(data []byte, raw string) ([]byte, int, http.Header, error) {
	headers := make(http.Header)
	if raw == "" {
		headers.Set("Content-Length", strconv.Itoa(len(data)))
		return data, http.StatusOK, headers, nil
	}
	var start, stop int
	if _, err := fmt.Sscanf(raw, "bytes=%d-%d", &start, &stop); err != nil || start < 0 || stop < start || start >= len(data) {
		return nil, 0, nil, errors.New("invalid range")
	}
	if stop >= len(data) {
		stop = len(data) - 1
	}
	body := data[start : stop+1]
	headers.Set("Content-Length", strconv.Itoa(len(body)))
	headers.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, stop, len(data)))
	return body, http.StatusPartialContent, headers, nil
}
