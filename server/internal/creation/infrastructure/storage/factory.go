package storage

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// Provider is the closed Object Storage provider set supported by Creation.
type Provider = domain.ObjectStorageProvider

const (
	ProviderOSS = domain.ObjectStorageProviderOSS
	ProviderCOS = domain.ObjectStorageProviderCOS
)

// Location is the non-secret, canonical Object Storage location.
type Location = domain.ObjectStorageLocation

// Credentials are one provider's long-lived key pair. They must remain
// transient in Go and must never be logged or returned to Desktop.
type Credentials = domain.ObjectStorageCredentials

var (
	regionPattern    = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)+$`)
	ossBucketPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$`)
	cosBucketPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[1-9][0-9]{4,19}$`)
)

// NormalizeLocation canonicalizes user-entered location facts and rejects
// anything that could select a non-public or caller-controlled endpoint.
func NormalizeLocation(raw Location) (Location, error) {
	location := Location{
		Provider: Provider(strings.ToLower(strings.TrimSpace(string(raw.Provider)))),
		Region:   strings.ToLower(strings.TrimSpace(raw.Region)),
		Bucket:   strings.ToLower(strings.TrimSpace(raw.Bucket)),
	}
	if location.Provider != ProviderOSS && location.Provider != ProviderCOS {
		return Location{}, fmt.Errorf("creation: unsupported object storage provider %q", raw.Provider)
	}
	if len(location.Region) > 32 || !regionPattern.MatchString(location.Region) || hasNonPublicEndpointMarker(location.Region) {
		return Location{}, fmt.Errorf("creation: invalid %s public region", location.Provider)
	}
	switch location.Provider {
	case ProviderOSS:
		if !ossBucketPattern.MatchString(location.Bucket) {
			return Location{}, errors.New("creation: invalid OSS bucket name")
		}
	case ProviderCOS:
		if !cosBucketPattern.MatchString(location.Bucket) || len(location.Host()) > 60 {
			return Location{}, errors.New("creation: invalid COS bucket name")
		}
	}
	return location, nil
}

func hasNonPublicEndpointMarker(region string) bool {
	for _, marker := range []string{"internal", "accelerate", "dualstack", "dual-stack", "cdn"} {
		if strings.Contains(region, marker) {
			return true
		}
	}
	return false
}

// NewBlobStore constructs exactly one production adapter for the selected
// canonical provider. Construction performs no bucket or control-plane call.
func NewBlobStore(location Location, credentials Credentials) (domain.DirectUploadBlobStore, error) {
	return newCloudStore(location, credentials)
}

// NewReferenceTransport constructs the narrow Provider Transfer Object seam
// over the selected production adapter.
func NewReferenceTransport(location Location, credentials Credentials) (domain.ReferenceTransport, error) {
	store, err := newCloudStore(location, credentials)
	if err != nil {
		return nil, err
	}
	return newReferenceTransport(store), nil
}

func newCloudStore(location Location, credentials Credentials) (referenceObjectStore, error) {
	location, err := NormalizeLocation(location)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(credentials.AccessKeyID) == "" || strings.TrimSpace(credentials.SecretAccessKey) == "" {
		return nil, errors.New("creation: object storage credentials are required")
	}
	switch location.Provider {
	case ProviderOSS:
		return newOSSStore(location, credentials, nil)
	case ProviderCOS:
		return newCOSStore(location, credentials, nil)
	default:
		panic("normalized provider escaped its closed set")
	}
}
