//go:build cloudsmoke

package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func runRealCloudSmoke(t *testing.T, location Location, credentials Credentials) {
	t.Helper()
	store, err := NewBlobStore(location, credentials)
	if err != nil {
		t.Fatalf("construct %s adapter failed", location.Provider)
	}

	stamp := time.Now().UTC()
	prefix := "nevix-smoke/" + string(location.Provider) + "/" + stamp.Format("20060102T150405Z") + "/" + domain.NewUUID().String() + "/"
	providerJobID := domain.NewUUID()
	keys := []string{prefix + "server-put", prefix + "signed-put", providerTransferKey(providerJobID, 0)}
	t.Cleanup(func() {
		cleanup := "pass"
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, key := range keys {
			if err := store.Delete(ctx, key); err != nil {
				cleanup = "fail"
				t.Errorf("%s smoke exact-key cleanup failed", location.Provider)
			}
		}
		result := "pass"
		if t.Failed() {
			result = "fail"
		}
		t.Logf("object-storage-smoke provider=%s adapter_version=%s date=%s result=%s cleanup=%s", location.Provider, adapterVersion(location.Provider), stamp.Format(time.DateOnly), result, cleanup)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	payload := []byte("nevix object storage conformance")
	if _, err := store.Put(ctx, keys[0], bytes.NewReader(payload), 1024); err != nil {
		t.Fatal("Put failed")
	}
	if _, err := store.Put(ctx, keys[0], strings.NewReader("overwrite"), 1024); !errors.Is(err, domain.ErrBlobConflict) {
		t.Fatalf("second Put error = %v, want conflict", err)
	}
	info, err := store.Head(ctx, keys[0])
	if err != nil || info.ByteSize != int64(len(payload)) {
		t.Fatalf("Head failed or returned byte_size=%d", info.ByteSize)
	}
	reader, size, err := store.Open(ctx, keys[0], domain.BlobRange{Offset: 6, Length: 6})
	if err != nil {
		t.Fatal("Open range failed")
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
		t.Fatal("PresignPut failed")
	}
	putSigned := func(body string) int {
		req, err := http.NewRequestWithContext(ctx, signed.Method, signed.URL, io.NopCloser(strings.NewReader(body)))
		if err != nil {
			t.Fatal("build signed PUT failed")
		}
		for name, value := range signed.Headers {
			req.Header.Set(name, value)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal("execute signed PUT failed")
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
		t.Fatal("signed Head failed or returned unexpected safe metadata")
	}
	if err := store.Delete(ctx, keys[0]); err != nil {
		t.Fatal("Delete failed")
	}
	if _, err := store.Head(ctx, keys[0]); !errors.Is(err, domain.ErrBlobNotFound) {
		t.Fatalf("Head after Delete error = %v", err)
	}

	transport, err := NewReferenceTransport(location, credentials)
	if err != nil {
		t.Fatal("construct ReferenceTransport failed")
	}
	transferPayload := []byte("nevix provider transfer conformance")
	transferDigest := sha256.Sum256(transferPayload)
	prepared, err := transport.Prepare(ctx, providerJobID, 0, domain.ReferenceSource{
		Role: domain.RoleReference, Kind: domain.KindImage, MIMEType: "image/png",
		ByteSize: int64(len(transferPayload)), SHA256Sum: transferDigest,
		Open: func(context.Context) (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(transferPayload)), nil
		},
	})
	if err != nil {
		t.Fatal("prepare Provider Transfer Object failed")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, prepared.URL, nil)
	if err != nil {
		t.Fatal("build Provider Transfer Object GET failed")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal("fetch Provider Transfer Object failed")
	}
	gotTransfer, readErr := io.ReadAll(response.Body)
	response.Body.Close()
	if readErr != nil || response.StatusCode < 200 || response.StatusCode >= 300 || !bytes.Equal(gotTransfer, transferPayload) {
		t.Fatal("Provider Transfer Object was not directly readable")
	}
	if err := transport.Release(ctx, providerJobID, 0); err != nil {
		t.Fatal("release Provider Transfer Object failed")
	}
	if err := transport.Release(ctx, providerJobID, 0); err != nil {
		t.Fatal("repeat Provider Transfer Object release failed")
	}
	if _, err := store.Head(ctx, keys[2]); !errors.Is(err, domain.ErrBlobNotFound) {
		t.Fatal("Provider Transfer Object remained after release")
	}
}

func adapterVersion(provider Provider) string {
	if version := os.Getenv("NEVIX_OBJECT_STORAGE_ADAPTER_VERSION"); version != "" {
		return version
	}
	modulePath := "github.com/aliyun/alibabacloud-oss-go-sdk-v2"
	if provider == ProviderCOS {
		modulePath = "github.com/tencentyun/cos-go-sdk-v5"
	}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	for _, dependency := range info.Deps {
		if dependency.Path == modulePath {
			return dependency.Version
		}
	}
	return "unknown"
}
