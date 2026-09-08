package storage

import (
	"net/http"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func TestOSSConformance(t *testing.T) {
	runCloudConformanceSuite(t, ProviderOSS, func(t *testing.T, transport http.RoundTripper) domain.DirectUploadBlobStore {
		t.Helper()
		store, err := newOSSStore(
			Location{Provider: ProviderOSS, Region: "cn-hangzhou", Bucket: "nevix-test"},
			Credentials{AccessKeyID: "test-ak", SecretAccessKey: "test-sk"},
			&http.Client{Transport: transport},
		)
		if err != nil {
			t.Fatalf("newOSSStore: %v", err)
		}
		return store
	})
}
