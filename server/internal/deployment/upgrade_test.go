package deployment_test

import (
	"github.com/nevix-ai/server/internal/deployment"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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

// The privileged bind mount exists only inside a fresh private mount namespace in native CI.
func TestUpgradeRejectsBindMountedBackupAlias(t *testing.T) {
	if instance := os.Getenv("NEVIX_DEPLOY_BIND_INSTANCE"); instance != "" {
		alias := os.Getenv("NEVIX_DEPLOY_BIND_ALIAS")
		err := deployment.Run([]string{"upgrade", "--directory", instance, "--original-bundle", "missing.tar.gz", "--original-manifest", "missing.json", "--bundle", "missing.tar.gz", "--manifest", "missing.json", "--backup", filepath.Join(alias, "upgrade.json"), "--token-file", "missing.session"}, "")
		if err == nil || !strings.Contains(err.Error(), "backup must be outside instance") {
			t.Fatalf("bind-mounted alias accepted before mutation: %v", err)
		}
		entries, err := os.ReadDir(instance)
		if err != nil || len(entries) != 0 {
			t.Fatal("bind-mounted backup rejection mutated instance")
		}
		return
	}
	if os.Getenv("NEVIX_DEPLOY_INTEGRATION_REQUESTED") != "1" {
		t.Skip("native isolated mount namespace required")
	}
	instance, alias := t.TempDir(), t.TempDir()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := `mount --bind "$1" "$2"; exec setpriv --reuid "$3" --regid "$4" --init-groups "$5" -test.run '^TestUpgradeRejectsBindMountedBackupAlias$' -test.v -test.count=1`
	cmd := exec.Command("sudo", "--preserve-env=NEVIX_DEPLOY_BIND_INSTANCE,NEVIX_DEPLOY_BIND_ALIAS", "unshare", "--mount", "--propagation", "private", "sh", "-ec", script, "bind-alias", instance, alias, strconv.Itoa(os.Getuid()), strconv.Itoa(os.Getgid()), binary)
	cmd.Env = append(os.Environ(), "NEVIX_DEPLOY_BIND_INSTANCE="+instance, "NEVIX_DEPLOY_BIND_ALIAS="+alias)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("isolated native bind alias regression: %v %s", err, out)
	}
}
