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
