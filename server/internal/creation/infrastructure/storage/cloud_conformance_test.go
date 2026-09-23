package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
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

type newCloudStoreForTest func(t *testing.T, transport http.RoundTripper) domain.ObjectStorageBlobStore

func runCloudConformanceSuite(t *testing.T, newStore newCloudStoreForTest) {
	t.Helper()

	t.Run("BlobStore", func(t *testing.T) {
		backend := newFakeCloudTransport()
		runConformanceSuite(t, func(t *testing.T) domain.BlobStore {
			t.Helper()
			return newStore(t, backend)
		})
	})

	t.Run("ReferenceTransport", func(t *testing.T) {
		runReferenceTransportConformanceSuite(t, newStore)
	})

	t.Run("HeadReportsAuthoritativeFacts", func(t *testing.T) {
		backend := newFakeCloudTransport()
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
		backend := newFakeCloudTransport()
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
		backend := newFakeCloudTransport()
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
		backend := newFakeCloudTransport()
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

	t.Run("PresignedThumbnailSignsResizeIntoTheSignature", func(t *testing.T) {
		backend := newFakeCloudTransport()
		store := newStore(t, backend)
		ctx := context.Background()
		if _, err := store.Put(ctx, "suite/thumb", strings.NewReader("image-bytes"), 1024); err != nil {
			t.Fatalf("Put: %v", err)
		}
		signedURL, err := store.PresignThumbnail(ctx, "suite/thumb", 10*time.Minute)
		if err != nil {
			t.Fatalf("PresignThumbnail: %v", err)
		}
		query := mustParseSignedQuery(t, signedURL, backend.origin())
		if got := query.Get("x-oss-process"); got != "image/resize,m_lfit,w_320/format,webp" {
			t.Fatalf("x-oss-process = %q, want the 320px WebP resize chain", got)
		}
		// The bare GET the URL authorizes carries no Authorization header; the
		// fake admits it on the presence of a signature alone, so what this
		// shows is that the URL is self-authorizing, not that the chain above
		// is the one the provider hashed.
		signedReq, err := http.NewRequestWithContext(ctx, http.MethodGet, signedURL, nil)
		if err != nil {
			t.Fatalf("build signed GET: %v", err)
		}
		resp, err := (&http.Client{Transport: backend}).Do(signedReq)
		if err != nil {
			t.Fatalf("signed thumbnail GET: %v", err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || string(body) != "image-bytes" {
			t.Fatalf("signed thumbnail GET = %d %q, want the stored object", resp.StatusCode, body)
		}
	})

	t.Run("PresignedPreviewSignsImageResizeAndRawMedia", func(t *testing.T) {
		backend := newFakeCloudTransport()
		store := newStore(t, backend)
		ctx := context.Background()
		if _, err := store.Put(ctx, "suite/preview", strings.NewReader("media-bytes"), 1024); err != nil {
			t.Fatalf("Put: %v", err)
		}
		imageURL, err := store.PresignPreview(ctx, "suite/preview", domain.KindImage, 10*time.Minute)
		if err != nil {
			t.Fatalf("PresignPreview image: %v", err)
		}
		imageQuery := mustParseSignedQuery(t, imageURL, backend.origin())
		if got := imageQuery.Get("x-oss-process"); got != "image/resize,m_lfit,w_2048/format,webp" {
			t.Fatalf("x-oss-process = %q, want the 2048px WebP resize chain", got)
		}
		rawURL, err := store.PresignPreview(ctx, "suite/preview", domain.KindVideo, 10*time.Minute)
		if err != nil {
			t.Fatalf("PresignPreview video: %v", err)
		}
		rawQuery := mustParseSignedQuery(t, rawURL, backend.origin())
		if _, ok := rawQuery["x-oss-process"]; ok {
			t.Fatalf("raw preview GET must not carry a processing chain: %s", rawURL)
		}
		// Range is not part of the signature either: the same URL authorizes a
		// ranged GET, which is how Chromium pulls the byte ranges it wants.
		// `presignGetProcess` already fails closed on any signed header.
		rangedReq, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
		if err != nil {
			t.Fatalf("build ranged preview GET: %v", err)
		}
		rangedReq.Header.Set("Range", "bytes=0-4")
		rangedResp, err := (&http.Client{Transport: backend}).Do(rangedReq)
		if err != nil {
			t.Fatalf("ranged preview GET: %v", err)
		}
		rangedBody, _ := io.ReadAll(rangedResp.Body)
		rangedResp.Body.Close()
		if rangedResp.StatusCode != http.StatusPartialContent || string(rangedBody) != "media" {
			t.Fatalf("ranged preview GET = %d %q, want the requested slice", rangedResp.StatusCode, rangedBody)
		}
		// Both bare GETs are answered on their signature alone. That they
		// differ per kind, and that each still authorizes, is what ties the
		// variant query to the URL rather than to a shared bare key.
		for name, signedURL := range map[string]string{"image": imageURL, "raw": rawURL} {
			signedReq, err := http.NewRequestWithContext(ctx, http.MethodGet, signedURL, nil)
			if err != nil {
				t.Fatalf("build signed GET (%s): %v", name, err)
			}
			resp, err := (&http.Client{Transport: backend}).Do(signedReq)
			if err != nil {
				t.Fatalf("signed preview GET (%s): %v", name, err)
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK || string(body) != "media-bytes" {
				t.Fatalf("signed preview GET (%s) = %d %q, want the stored object", name, resp.StatusCode, body)
			}
		}
	})

	t.Run("MapsProviderErrorsWithoutLeakingResponses", func(t *testing.T) {
		backend := newFakeCloudTransport()
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
		backend := newFakeCloudTransport()
		store := newStore(t, backend)
		for _, key := range []string{fakeMissingBucketKey, fakeUnrelatedConflictKey} {
			_, err := store.Head(context.Background(), key)
			if !errors.Is(err, domain.ErrObjectStorageConfiguration) {
				t.Fatalf("Head(%q) error = %v, want ErrObjectStorageConfiguration", key, err)
			}
			if errors.Is(err, domain.ErrBlobNotFound) || errors.Is(err, domain.ErrBlobConflict) {
				t.Fatalf("Head(%q) misclassified provider error: %v", key, err)
			}
			if strings.Contains(err.Error(), fakeSensitiveProviderMessage) {
				t.Fatalf("Head(%q) leaked provider response: %v", key, err)
			}
		}
	})

}

func mustParseSignedQuery(t *testing.T, signedURL, wantOrigin string) url.Values {
	t.Helper()
	parsed, err := url.Parse(signedURL)
	if err != nil {
		t.Fatalf("parse signed URL: %v", err)
	}
	if got := parsed.Scheme + "://" + parsed.Host; got != wantOrigin {
		t.Fatalf("signed origin = %q, want %q", got, wantOrigin)
	}
	return parsed.Query()
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
	fakeSensitiveProviderMessage = "credential-secret-from-provider"
)

type fakeCloudObject struct {
	body        []byte
	contentType string
	metadata    map[string]string
}

type fakeCloudTransport struct {
	mu                   sync.Mutex
	objects              map[string]fakeCloudObject
	last                 http.Header
	methods              map[string]int
	failMethod           string
	failStatus           int
	failCode             string
	commitThenFailPut    bool
	corruptCommittedBody bool
	cancelOnHead         context.CancelFunc
	deleteGate           <-chan struct{}
	headSizeDelta        int64
	headContentType      string
	omitMetadata         string
	sawAnonymousGet      bool
	sawRangeGet          bool
}

func newFakeCloudTransport() *fakeCloudTransport {
	return &fakeCloudTransport{objects: make(map[string]fakeCloudObject), methods: make(map[string]int)}
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
	cancelOnHead := f.cancelOnHead
	if req.Method == http.MethodHead {
		f.cancelOnHead = nil
	}
	deleteGate := f.deleteGate
	if req.Method == f.failMethod {
		status := f.failStatus
		if status == 0 {
			status = http.StatusServiceUnavailable
		}
		code := f.failCode
		if code == "" {
			code = "ServiceUnavailable"
		}
		f.mu.Unlock()
		return f.errorResponse(req, status, code, fakeSensitiveProviderMessage), nil
	}
	f.mu.Unlock()
	if req.Method == http.MethodHead && cancelOnHead != nil {
		cancelOnHead()
		return nil, req.Context().Err()
	}
	if req.Method == http.MethodDelete && deleteGate != nil {
		select {
		case <-deleteGate:
		case <-req.Context().Done():
			return nil, req.Context().Err()
		}
	}
	switch key {
	case fakeProviderErrorKey:
		return f.errorResponse(req, http.StatusServiceUnavailable, "ServiceUnavailable", fakeSensitiveProviderMessage), nil
	case fakeMissingBucketKey:
		return f.errorResponse(req, http.StatusNotFound, "NoSuchBucket", fakeSensitiveProviderMessage), nil
	case fakeUnrelatedConflictKey:
		return f.errorResponse(req, http.StatusConflict, f.unrelatedConflictCode(), fakeSensitiveProviderMessage), nil
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
		metadata := map[string]string{}
		for name, values := range req.Header {
			if metadataName, ok := strings.CutPrefix(strings.ToLower(name), f.metadataHeaderPrefix()); ok && len(values) > 0 {
				metadata[metadataName] = values[0]
			}
		}
		storedBody := body
		if f.corruptCommittedBody && len(storedBody) > 0 {
			storedBody = append([]byte(nil), storedBody...)
			storedBody[0] ^= 0xff
			f.corruptCommittedBody = false
		}
		f.objects[key] = fakeCloudObject{
			body:        storedBody,
			contentType: req.Header.Get("Content-Type"),
			metadata:    metadata,
		}
		if f.commitThenFailPut {
			f.commitThenFailPut = false
			return nil, errors.New("response lost after committed put")
		}
		return f.response(req, http.StatusOK, nil, nil), nil
	case http.MethodHead:
		object, exists := f.objects[key]
		if !exists {
			return f.errorResponse(req, http.StatusNotFound, "NoSuchKey", "missing"), nil
		}
		headers := make(http.Header)
		headers.Set("Content-Length", strconv.FormatInt(int64(len(object.body))+f.headSizeDelta, 10))
		contentType := object.contentType
		if f.headContentType != "" {
			contentType = f.headContentType
		}
		headers.Set("Content-Type", contentType)
		for name, value := range object.metadata {
			if name != f.omitMetadata {
				headers.Set(f.metadataHeaderPrefix()+name, value)
			}
		}
		return f.response(req, http.StatusOK, headers, nil), nil
	case http.MethodGet:
		if req.Header.Get("Authorization") == "" && req.URL.Query().Get("x-oss-signature") == "" {
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
		return nil, fmt.Errorf("unexpected cloud control-plane or list request: %s", req.Method)
	}
}

func (f *fakeCloudTransport) sawMethod(method string) bool {
	return f.methods[method] > 0
}

func (f *fakeCloudTransport) unrelatedConflictCode() string {
	return "FileImmutable"
}

func (f *fakeCloudTransport) origin() string {
	return "https://nevix-test.oss-cn-hangzhou.aliyuncs.com"
}

func (f *fakeCloudTransport) forbidOverwriteHeader() string {
	return "x-oss-forbid-overwrite"
}

func (f *fakeCloudTransport) metadataHeaderName() string {
	return f.metadataHeaderPrefix() + domain.UploadIDMetadataKey
}

func (f *fakeCloudTransport) metadataHeaderPrefix() string {
	return "x-oss-meta-"
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
