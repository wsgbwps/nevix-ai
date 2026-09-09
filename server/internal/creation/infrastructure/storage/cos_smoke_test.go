//go:build cloudsmoke

package storage

import (
	"os"
	"testing"
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
	runRealCloudSmoke(t,
		Location{Provider: ProviderCOS, Region: region, Bucket: bucket},
		Credentials{AccessKeyID: secretID, SecretAccessKey: secretKey},
	)
}
