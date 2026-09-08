//go:build cloudsmoke

package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func runRealCloudSmoke(t *testing.T, location Location, credentials Credentials) {
	t.Helper()
	store, err := NewBlobStore(location, credentials)
	if err != nil {
		t.Fatalf("construct %s adapter: %v", location.Provider, err)
	}

	stamp := time.Now().UTC()
	prefix := "nevix-smoke/" + string(location.Provider) + "/" + stamp.Format("20060102T150405Z") + "/" + domain.NewUUID().String() + "/"
	keys := []string{prefix + "server-put", prefix + "signed-put"}
	t.Cleanup(func() {
		cleanup := "pass"
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, key := range keys {
			if err := store.Delete(ctx, key); err != nil {
				cleanup = "fail"
				t.Errorf("%s smoke exact-key cleanup failed: %v", location.Provider, err)
			}
		}
		result := "pass"
		if t.Failed() {
			result = "fail"
		}
		t.Logf("object-storage-smoke provider=%s date=%s result=%s cleanup=%s", location.Provider, stamp.Format(time.DateOnly), result, cleanup)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	payload := []byte("nevix object storage conformance")
	if _, err := store.Put(ctx, keys[0], bytes.NewReader(payload), 1024); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if _, err := store.Put(ctx, keys[0], strings.NewReader("overwrite"), 1024); !errors.Is(err, domain.ErrBlobConflict) {
		t.Fatalf("second Put error = %v, want conflict", err)
	}
	info, err := store.Head(ctx, keys[0])
	if err != nil || info.ByteSize != int64(len(payload)) {
		t.Fatalf("Head = %#v, %v", info, err)
	}
	reader, size, err := store.Open(ctx, keys[0], domain.BlobRange{Offset: 6, Length: 6})
	if err != nil {
		t.Fatalf("Open range: %v", err)
	}
	window, readErr := io.ReadAll(reader)
	reader.Close()
	if readErr != nil || size != int64(len(payload)) || string(window) != "object" {
		t.Fatalf("range = %q size=%d error=%v", window, size, readErr)
	}
	canceled, cancelRead := context.WithCancel(ctx)
	cancelRead()
	if _, _, err := store.Open(canceled, keys[0], domain.FullBlobRange); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled Open error = %v", err)
	}

	signed, err := store.PresignPut(ctx, domain.PresignPutRequest{
		Key:         keys[1],
		ContentType: "application/octet-stream",
		UploadID:    "smoke-upload",
		ExpiresIn:   10 * time.Minute,
	})
	if err != nil {
		t.Fatalf("PresignPut: %v", err)
	}
	putSigned := func(body string) int {
		req, err := http.NewRequestWithContext(ctx, signed.Method, signed.URL, io.NopCloser(strings.NewReader(body)))
		if err != nil {
			t.Fatalf("build signed PUT: %v", err)
		}
		for name, value := range signed.Headers {
			req.Header.Set(name, value)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("execute signed PUT: %v", err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if status := putSigned("signed smoke"); status < 200 || status >= 300 {
		t.Fatalf("signed PUT status = %d", status)
	}
	if status := putSigned("overwrite"); status != http.StatusConflict {
		t.Fatalf("second signed PUT status = %d, want conflict", status)
	}
	signedInfo, err := store.Head(ctx, keys[1])
	if err != nil || signedInfo.ContentType != "application/octet-stream" || signedInfo.Metadata[domain.UploadIDMetadataKey] != "smoke-upload" {
		t.Fatalf("signed Head = %#v, %v", signedInfo, err)
	}
	if err := store.Delete(ctx, keys[0]); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := store.Head(ctx, keys[0]); !errors.Is(err, domain.ErrBlobNotFound) {
		t.Fatalf("Head after Delete error = %v", err)
	}
}
