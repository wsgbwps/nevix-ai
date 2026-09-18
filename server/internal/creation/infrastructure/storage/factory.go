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
)

// Location is the non-secret, canonical Object Storage location.
type Location = domain.ObjectStorageLocation

// Credentials are one provider's long-lived key pair. They must remain
// transient in Go and must never be logged or returned to Desktop.
type Credentials = domain.ObjectStorageCredentials

var (
	regionPattern    = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)+$`)
	ossBucketPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$`)
)

// NormalizeLocation canonicalizes user-entered location facts and rejects
// anything that could select a non-public or caller-controlled endpoint.
func NormalizeLocation(raw Location) (Location, error) {
	location := Location{
		Provider: Provider(strings.ToLower(strings.TrimSpace(string(raw.Provider)))),
		Region:   strings.ToLower(strings.TrimSpace(raw.Region)),
		Bucket:   strings.ToLower(strings.TrimSpace(raw.Bucket)),
	}
	if location.Provider != ProviderOSS {
		return Location{}, fmt.Errorf("creation: unsupported object storage provider %q", raw.Provider)
	}
	if len(location.Region) > 32 || !regionPattern.MatchString(location.Region) || hasNonPublicEndpointMarker(location.Region) {
		return Location{}, fmt.Errorf("creation: invalid %s public region", location.Provider)
	}
	if !ossBucketPattern.MatchString(location.Bucket) {
		return Location{}, errors.New("creation: invalid OSS bucket name")
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

// NewBlobStore constructs the OSS production adapter. Construction performs no
// bucket or control-plane call.
func NewBlobStore(location Location, credentials Credentials) (domain.ObjectStorageBlobStore, error) {
	return newCloudStore(location, credentials)
}

// NewReferenceTransport constructs the narrow Provider Transfer Object seam
// over the OSS production adapter.
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
	return newOSSStore(location, credentials, nil)
}
