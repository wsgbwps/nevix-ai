//go:build cloudsmoke

package storage

import (
	"context"
	"os"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

func TestCOSRealSmoke(t *testing.T) {
	requested := os.Getenv("NEVIX_COS_SMOKE_REQUESTED") == "1"
	region := os.Getenv("NEVIX_COS_SMOKE_REGION")
	bucket := os.Getenv("NEVIX_COS_SMOKE_BUCKET")
	secretID := os.Getenv("NEVIX_COS_SMOKE_SECRET_ID")
	secretKey := os.Getenv("NEVIX_COS_SMOKE_SECRET_KEY")
	if region == "" || bucket == "" || secretID == "" || secretKey == "" {
		if requested {
			t.Fatal("requested COS smoke is missing NEVIX_COS_SMOKE_REGION, BUCKET, SECRET_ID, or SECRET_KEY")
		}
		t.Skip("COS smoke environment is not configured")
	}
	location := Location{Provider: ProviderCOS, Region: region, Bucket: bucket}
	credentials := Credentials{AccessKeyID: secretID, SecretAccessKey: secretKey}
	t.Run("basic adapter conformance", func(t *testing.T) {
		runRealCloudSmoke(t, location, credentials)
	})
	t.Run("production connection canary", func(t *testing.T) {
		_, err := VerifyConnection(context.Background(), domain.ObjectStorageCandidate{
			Location: location,
			Credentials: domain.ObjectStorageCredentials{
				AccessKeyID: secretID, SecretAccessKey: secretKey,
			},
		})
		if err != nil {
			t.Fatal("production connection canary failed")
		}
	})
}
