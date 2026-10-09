package deployment_test

import (
	"github.com/nevix-ai/server/internal/deployment"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUpgradeRejectsUntrustedCandidateBeforeDockerOrMaintenance(t *testing.T) {
	dir := t.TempDir()
	token := filepath.Join(dir, "session")
	if err := os.WriteFile(token, []byte("fixture-token"), 0600); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(dir, "candidate.json")
	if err := os.WriteFile(manifest, []byte(`{"format":"nevix-release-v1","payload":"e30=","signature":""}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())
	err := deployment.Run([]string{"upgrade", "--directory", dir, "--manifest", manifest, "--bundle", "missing.tar.gz", "--original-manifest", manifest, "--original-bundle", "missing-original.tar.gz", "--backup", filepath.Join(t.TempDir(), "backup.tar.gz"), "--server-url", "https://127.0.0.1", "--tls-fingerprint", strings.Repeat("a", 64), "--token-file", token}, "")
	if err == nil || !strings.Contains(err.Error(), "verify signed release") {
		t.Fatalf("candidate trust must fail before any Docker or maintenance call: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "upgrade.json")); !os.IsNotExist(err) {
		t.Fatal("untrusted candidate wrote operation journal")
	}
}

func TestUpgradeRejectsBackupInsideInstanceIncludingAliasesBeforeMutation(t *testing.T) {
	root := t.TempDir()
	instance := filepath.Join(root, "instance")
	if err := os.Mkdir(instance, 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(instance, alias); err != nil {
		t.Fatal(err)
	}
	for _, backup := range []string{filepath.Join(instance, "upgrade.json"), filepath.Join(instance, "current"), filepath.Join(instance, "new-backup.tar.gz"), filepath.Join(alias, "upgrade.json"), filepath.Join(instance, "child", "..", "upgrade.json")} {
		err := deployment.Run([]string{"upgrade", "--directory", instance, "--original-bundle", "missing-original.tar.gz", "--original-manifest", "missing-original.json", "--bundle", "missing.tar.gz", "--manifest", "missing.json", "--backup", backup, "--token-file", "missing.session"}, "")
		if err == nil || !strings.Contains(err.Error(), "backup must be outside instance") {
			t.Fatalf("backup alias must be rejected before any mutation: %s: %v", backup, err)
		}
		entries, err := os.ReadDir(instance)
		if err != nil || len(entries) != 0 {
			t.Fatal("unsafe backup path mutated instance")
		}
	}
}
