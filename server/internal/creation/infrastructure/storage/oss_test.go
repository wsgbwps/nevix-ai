package storage

import (
	"context"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

type flakyHeadTransport struct {
	http.RoundTripper
	timeouts int
	attempts int
}

func (f *flakyHeadTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.Method == http.MethodHead {
		f.attempts++
		if f.timeouts > 0 {
			f.timeouts--
			return nil, &net.DNSError{Err: "timeout", IsTimeout: true}
		}
	}
	return f.RoundTripper.RoundTrip(request)
}

func TestOSSConformance(t *testing.T) {
	runCloudConformanceSuite(t, func(t *testing.T, transport http.RoundTripper) domain.ObjectStorageBlobStore {
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

func TestOSSHeadRetriesTransientTimeout(t *testing.T) {
	backend := newFakeCloudTransport()
	transport := &flakyHeadTransport{RoundTripper: backend, timeouts: 3}
	store, err := newOSSStore(
		Location{Provider: ProviderOSS, Region: "cn-hangzhou", Bucket: "nevix-test"},
		Credentials{AccessKeyID: "test-ak", SecretAccessKey: "test-sk"},
		&http.Client{Transport: transport},
	)
	if err != nil {
		t.Fatalf("newOSSStore: %v", err)
	}
	if _, err := store.Put(context.Background(), "suite/retry", strings.NewReader("ok"), 16); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if _, err := store.Head(context.Background(), "suite/retry"); err != nil {
		t.Fatalf("Head after transient timeout: %v", err)
	}
	if transport.attempts != 4 {
		t.Fatalf("Head attempts = %d, want 4", transport.attempts)
	}
}
