package deployment_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nevix-ai/server/internal/deployment"
)

func TestRestoreRequiresExplicitPostBackupDataLossConfirmation(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	err := deployment.Run([]string{"restore", "--directory", t.TempDir(), "--backup", "missing.tar.gz", "--manifest", "missing.json", "--bundle", "missing-release.tar.gz"}, "")
	if err == nil || !strings.Contains(err.Error(), "post-backup writes") {
		t.Fatalf("explicit data-loss confirmation must precede any Docker/destructive action: %v", err)
	}
}

func TestBackupRejectsExposedAdminSessionFileBeforeDocker(t *testing.T) {
	dir := t.TempDir()
	token := filepath.Join(dir, "session")
	if err := os.WriteFile(token, []byte("fixture-token"), 0644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())
	err := deployment.Run([]string{"backup", "--directory", dir, "--output", filepath.Join(dir, "backup.tar.gz"), "--manifest", "missing.json", "--bundle", "missing-release.tar.gz", "--server-url", "https://127.0.0.1", "--tls-fingerprint", strings.Repeat("a", 64), "--token-file", token}, "")
	if err == nil || !strings.Contains(err.Error(), "private regular file") {
		t.Fatalf("exposed credential rejected before use: %v", err)
	}
}

func TestRestoreRejectsUnsafeCustomerConfigBeforeDocker(t *testing.T) {
	for _, kind := range []string{"symlink", "public-file", "public-directory"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			outside := filepath.Join(t.TempDir(), "host-data")
			if err := os.WriteFile(outside, []byte("must remain unchanged"), 0600); err != nil {
				t.Fatal(err)
			}
			env := filepath.Join(dir, ".env")
			switch kind {
			case "symlink":
				if err := os.Symlink(outside, env); err != nil {
					t.Fatal(err)
				}
			case "public-file":
				if err := os.WriteFile(env, []byte("exposed"), 0644); err != nil {
					t.Fatal(err)
				}
			case "public-directory":
				if err := os.Chmod(dir, 0755); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("PATH", t.TempDir())
			err := deployment.Run([]string{"restore", "--directory", dir, "--bundle", "original.tar.gz", "--manifest", "original.json", "--backup", "backup.tar.gz", "--confirm", "RESTORE-LOSE-POST-BACKUP-WRITES", "--server-url", "https://127.0.0.1", "--tls-fingerprint", strings.Repeat("a", 64)}, "")
			if err == nil || !strings.Contains(err.Error(), "private") {
				t.Fatalf("unsafe config must fail before restore/Docker: %v", err)
			}
			have, e := os.ReadFile(outside)
			if e != nil || string(have) != "must remain unchanged" {
				t.Fatal("restore followed customer config symlink")
			}
		})
	}
}

func TestBackupBoundsSparsePublisherManifestBeforeDocker(t *testing.T) {
	dir := t.TempDir()
	manifest := filepath.Join(dir, "oversized.json")
	f, err := os.Create(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Truncate(8 << 30); err != nil {
		t.Fatal(err)
	}
	f.Close()
	token := filepath.Join(dir, "session")
	if err = os.WriteFile(token, []byte("fixture-token"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())
	err = deployment.Run([]string{"backup", "--directory", dir, "--manifest", manifest, "--bundle", "missing.tar.gz", "--output", filepath.Join(dir, "backup.tar.gz"), "--server-url", "https://127.0.0.1", "--tls-fingerprint", strings.Repeat("a", 64), "--token-file", token}, "")
	if err == nil || !strings.Contains(err.Error(), "manifest too large") {
		t.Fatalf("manifest must be bounded before trust/runtime work: %v", err)
	}
}
