//go:build cloudsmoke

package storage

import (
	"os"
	"testing"
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
	runRealCloudSmoke(t,
		Location{Provider: ProviderOSS, Region: region, Bucket: bucket},
		Credentials{AccessKeyID: accessKeyID, SecretAccessKey: secretAccessKey},
	)
}
