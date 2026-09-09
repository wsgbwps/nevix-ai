package storage

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func TestConnectionCanaryExercisesRequiredOperationsAndCleansUp(t *testing.T) {
	for _, provider := range []Provider{ProviderOSS, ProviderCOS} {
		t.Run(string(provider), func(t *testing.T) {
			backend := newFakeCloudTransport(provider)
			location := canaryTestLocation(provider)
			client := &http.Client{Transport: backend}
			var store domain.DirectUploadBlobStore
			var err error
			if provider == ProviderOSS {
				store, err = newOSSStore(location, Credentials{AccessKeyID: "ak", SecretAccessKey: "sk"}, client)
			} else {
				store, err = newCOSStore(location, Credentials{AccessKeyID: "ak", SecretAccessKey: "sk"}, client)
			}
			if err != nil {
				t.Fatalf("construct store: %v", err)
			}

			if err := verifyConnectionCanary(context.Background(), location, store, client, "nevix-canary/test"); err != nil {
				t.Fatalf("verify canary: %v", err)
			}
			backend.mu.Lock()
			defer backend.mu.Unlock()
			if len(backend.objects) != 0 {
				t.Fatalf("canary left objects behind: %d", len(backend.objects))
			}
			for _, method := range []string{http.MethodPut, http.MethodHead, http.MethodGet, http.MethodDelete, http.MethodOptions} {
				if !backend.sawMethod(method) {
					t.Fatalf("canary never exercised %s", method)
				}
			}
			if !backend.sawAnonymousGet || !backend.sawOriginNullPreflight || !backend.sawRangeGet {
				t.Fatalf("canary observations: anonymous=%t origin-null=%t range=%t", backend.sawAnonymousGet, backend.sawOriginNullPreflight, backend.sawRangeGet)
			}
		})
	}
}

func TestConnectionCanaryFailureCleansPartialObjectAndReturnsOnlyStableError(t *testing.T) {
	backend := newFakeCloudTransport(ProviderOSS)
	backend.failMethod = http.MethodHead
	client := &http.Client{Transport: backend}
	location := canaryTestLocation(ProviderOSS)
	store, err := newOSSStore(location, Credentials{AccessKeyID: "sensitive-ak", SecretAccessKey: "sensitive-sk"}, client)
	if err != nil {
		t.Fatalf("construct store: %v", err)
	}
	err = verifyConnectionCanary(context.Background(), location, store, client, "sensitive-object-key")
	if !errors.Is(err, domain.ErrObjectStorageUnavailable) {
		t.Fatalf("canary error = %v", err)
	}
	for _, sensitive := range []string{"sensitive-ak", "sensitive-sk", "sensitive-object-key", fakeSensitiveProviderMessage} {
		if strings.Contains(err.Error(), sensitive) {
			t.Fatalf("canary error leaked %q: %v", sensitive, err)
		}
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if len(backend.objects) != 0 {
		t.Fatalf("failed canary left objects behind: %d", len(backend.objects))
	}
}

func canaryTestLocation(provider Provider) Location {
	if provider == ProviderOSS {
		return Location{Provider: provider, Region: "cn-hangzhou", Bucket: "nevix-test"}
	}
	return Location{Provider: provider, Region: "ap-shanghai", Bucket: "nevix-test-1250000000"}
}
