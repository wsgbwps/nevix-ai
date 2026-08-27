package storage

import (
	"context"
	"os"
	"testing"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// TestS3ConformanceSuiteAgainstMinIO runs the identical blob contract over
// an S3-compatible backend. The harness provisions MinIO and exports the
// NEVIX_CREATION_TEST_S3_* variables; without them ordinary runs skip, while
// a requested run fails loudly.
func TestS3ConformanceSuiteAgainstMinIO(t *testing.T) {
	endpoint := os.Getenv("NEVIX_CREATION_TEST_S3_ENDPOINT")
	accessKey := os.Getenv("NEVIX_CREATION_TEST_S3_ACCESS_KEY_ID")
	secretKey := os.Getenv("NEVIX_CREATION_TEST_S3_SECRET_ACCESS_KEY")
	requested := os.Getenv("NEVIX_CREATION_INTEGRATION_REQUESTED") == "1"
	if endpoint == "" || accessKey == "" || secretKey == "" {
		if requested {
			t.Fatal("requested Creation integration is missing NEVIX_CREATION_TEST_S3_* variables; run ./scripts/test-creation-integration.sh")
		}
		t.Skip("skipping: S3 conformance environment is not configured")
	}
	bucket := "nevix-creation-conformance"
	if raw := os.Getenv("NEVIX_CREATION_TEST_S3_BUCKET"); raw != "" {
		bucket = raw
	}
	secure := os.Getenv("NEVIX_CREATION_TEST_S3_SECURE") == "true"

	ctx := context.Background()
	provisionBucket(t, ctx, endpoint, bucket, accessKey, secretKey, secure)

	runConformanceSuite(t, func(t *testing.T) domain.BlobStore {
		t.Helper()
		store, err := NewS3(ctx, endpoint, accessKey, secretKey, "us-east-1", bucket, secure)
		if err != nil {
			t.Fatalf("new S3 store: %v", err)
		}
		return store
	})
}

// provisionBucket guarantees the suite's bucket exists; tests isolate keys
// under their own prefixes instead of separate buckets.
func provisionBucket(t *testing.T, ctx context.Context, endpoint, bucket, accessKey, secretKey string, secure bool) {
	t.Helper()
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: secure,
	})
	if err != nil {
		t.Fatalf("bootstrap S3 client: %v", err)
	}
	exists, err := client.BucketExists(ctx, bucket)
	if err != nil {
		t.Fatalf("probe S3 bucket %q: %v", bucket, err)
	}
	if exists {
		return
	}
	if err := client.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
		errResponse := minio.ToErrorResponse(err)
		if errResponse.Code == "BucketAlreadyOwnedByYou" || errResponse.Code == "BucketAlreadyExists" {
			return
		}
		t.Fatalf("create S3 bucket %q: %v", bucket, err)
	}
}
