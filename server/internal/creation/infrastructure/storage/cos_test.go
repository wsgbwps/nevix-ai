package storage

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func TestCOSPutIncludesOverwriteGuard(t *testing.T) {
	backend := newFakeCloudTransport(ProviderCOS)
	store, err := newCOSStore(
		Location{Provider: ProviderCOS, Region: "ap-shanghai", Bucket: "nevix-test-1250000000"},
		Credentials{AccessKeyID: "test-ak", SecretAccessKey: "test-sk"},
		&http.Client{Transport: backend},
	)
	if err != nil {
		t.Fatalf("newCOSStore: %v", err)
	}
	if _, err := store.Put(context.Background(), "suite/guard", strings.NewReader("body"), 1024); err != nil {
		t.Fatalf("Put: %v; request headers: %#v", err, backend.last)
	}
}

func TestCOSConformance(t *testing.T) {
	runCloudConformanceSuite(t, ProviderCOS, func(t *testing.T, transport http.RoundTripper) domain.DirectUploadBlobStore {
		t.Helper()
		store, err := newCOSStore(
			Location{Provider: ProviderCOS, Region: "ap-shanghai", Bucket: "nevix-test-1250000000"},
			Credentials{AccessKeyID: "test-ak", SecretAccessKey: "test-sk"},
			&http.Client{Transport: transport},
		)
		if err != nil {
			t.Fatalf("newCOSStore: %v", err)
		}
		return store
	})
}
