//go:build cloudsmoke

package storage

import (
	"context"
	"os"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func TestOSSRealSmoke(t *testing.T) {
	requested := os.Getenv("NEVIX_OSS_SMOKE_REQUESTED") == "1"
	region := os.Getenv("NEVIX_OSS_SMOKE_REGION")
	bucket := os.Getenv("NEVIX_OSS_SMOKE_BUCKET")
	accessKeyID := os.Getenv("NEVIX_OSS_SMOKE_ACCESS_KEY_ID")
	secretAccessKey := os.Getenv("NEVIX_OSS_SMOKE_SECRET_ACCESS_KEY")
	if region == "" || bucket == "" || accessKeyID == "" || secretAccessKey == "" {
		if requested {
			t.Fatal("requested OSS smoke is missing NEVIX_OSS_SMOKE_REGION, BUCKET, ACCESS_KEY_ID, or SECRET_ACCESS_KEY")
		}
		t.Skip("OSS smoke environment is not configured")
	}
	location := Location{Provider: ProviderOSS, Region: region, Bucket: bucket}
	credentials := Credentials{AccessKeyID: accessKeyID, SecretAccessKey: secretAccessKey}
	t.Run("basic adapter conformance", func(t *testing.T) {
		runRealCloudSmoke(t, location, credentials)
	})
	t.Run("production connection canary", func(t *testing.T) {
		_, err := VerifyConnection(context.Background(), domain.ObjectStorageCandidate{
			Location: location,
			Credentials: domain.ObjectStorageCredentials{
				AccessKeyID: accessKeyID, SecretAccessKey: secretAccessKey,
			},
		})
		if err != nil {
			t.Fatal("production connection canary failed")
		}
	})
}
