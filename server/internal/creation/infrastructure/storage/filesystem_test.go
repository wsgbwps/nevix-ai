package storage

import (
	"bytes"
	"context"
	"path/filepath"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// The filesystem adapter satisfies the shared conformance suite with no
// external dependencies; the S3 adapter runs the same suite under the
// requested integration runtime (s3_integration_test.go).
func TestFilesystemConformance(t *testing.T) {
	runConformanceSuite(t, func(t *testing.T) domain.BlobStore {
		t.Helper()
		root := t.TempDir()
		store, err := NewFilesystem(root)
		if err != nil {
			t.Fatalf("new filesystem store: %v", err)
		}
		return store
	})
}

func TestFilesystemRejectsRelativeRootAndTraversalKeys(t *testing.T) {
	if _, err := NewFilesystem("relative/path"); err == nil {
		t.Fatal("relative storage root must be rejected")
	}
	store, err := NewFilesystem(filepath.Join(t.TempDir(), "root"))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	ctx := context.Background()
	for _, key := range []string{"../escape", "../../escape"} {
		if _, putErr := store.Put(ctx, key, bytes.NewReader([]byte("x")), 1024); putErr == nil {
			t.Errorf("Put with traversal key %q succeeded", key)
		}
		if _, _, openErr := store.Open(ctx, key, domain.FullBlobRange); openErr == nil {
			t.Errorf("Open with traversal key %q succeeded", key)
		}
	}
}
