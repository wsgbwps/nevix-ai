package deployment_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/deployment"
)

func TestOfflineFirstInstallWithRealImages(t *testing.T) {
	bundle := os.Getenv("NEVIX_DEPLOY_RUNTIME_BUNDLE")
	if bundle == "" {
		if os.Getenv("NEVIX_DEPLOY_INTEGRATION_REQUESTED") == "1" {
			t.Fatal("real runtime bundle required")
		}
		t.Skip("run deploy/scripts/test-offline-runtime.sh on native Linux x64")
	}
	if os.Getenv("NEVIX_DEPLOY_ISOLATED_DAEMON") != "1" {
		t.Fatal("refusing fixed Nevix resources without isolated daemon")
	}
	docker := func(args ...string) []byte {
		t.Helper()
		cmd := exec.Command("docker", args...)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		b, err := cmd.Output()
		if err != nil {
			t.Fatalf("docker %s: %v (private subprocess output withheld)", args[0], err)
		}
		return b
	}
	if b := docker("image", "ls", "--quiet"); len(bytes.TrimSpace(b)) != 0 {
		t.Fatalf("acceptance daemon must have an empty image cache, actual image IDs: %s", b)
	}
	TestUpgradeRejectsBindMountedBackupAlias(t)
	t.Logf("Docker %s Compose %s", docker("version", "--format", "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"), docker("compose", "version", "--short"))
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	blocked := exec.CommandContext(ctx, "docker", "pull", "hello-world:latest")
	if b, err := blocked.CombinedOutput(); err == nil {
		t.Fatalf("registry traffic must be blocked, pulled image: %s", b)
	}
	manifest, key := signFile(t, bundle)
	dir := filepath.Join(t.TempDir(), "instance")
	if err := deployment.Run([]string{"import", "--manifest", manifest, "--bundle", bundle, "--directory", dir}, key); err != nil {
		t.Fatal(err)
	}
	env := []byte("NEVIX_PUBLIC_IP=127.0.0.1\nPOSTGRES_PASSWORD=runtimefixturepgpassword_345_24\nNEVIX_IDENTITY_APP_PASSWORD=runtimefixtureapppassword_345_24\nNEVIX_SETUP_CODE_REQUIRED=false\nCERT_FORCE_NEW=false\n")
	if err := os.WriteFile(filepath.Join(dir, ".env"), env, 0600); err != nil {
		t.Fatal(err)
	}
	if err := deployment.Run([]string{"install", "--manifest", manifest, "--bundle", bundle, "--directory", dir}, key); err != nil {
		t.Fatal(err)
	}
	compose := []string{"compose", "--project-name", "nevix", "--env-file", filepath.Join(dir, ".env"), "-f", filepath.Join(dir, "releases", "1.2.3", "compose.yaml")}
	invoke := func(args ...string) []byte { return docker(append(append([]string{}, compose...), args...)...) }
	preserved, err := os.ReadFile(filepath.Join(dir, ".env"))
	if err != nil || !bytes.Equal(env, preserved) {
		t.Fatal("installation replaced customer config")
	}
	edge := func(path string, body string) []byte {
		args := []string{"exec", "-T", "cert-watch", "wget", "-qO-", "--no-check-certificate"}
		if body != "" {
			args = append(args, "--header", "Content-Type: application/json", "--post-data", body)
		}
		return invoke(append(args, "https://nginx"+path)...)
	}
	var status struct {
		Initialized       bool `json:"initialized"`
		SetupCodeRequired bool `json:"setup_code_required"`
	}
	if json.Unmarshal(edge("/identity/setup/status", ""), &status) != nil || status.Initialized || status.SetupCodeRequired {
		t.Fatal("fresh real PostgreSQL instance not available through HTTPS")
	}
	var claim struct {
		SessionToken string `json:"token"`
		User         struct {
			Role string `json:"role"`
		}
	}
	b := edge("/identity/setup/initialize", `{"email":"offline345@example.com","password":"fixturePassword345!"}`)
	if json.Unmarshal(b, &claim) != nil || claim.SessionToken == "" || claim.User.Role != "admin" {
		t.Fatal("first claim through public HTTPS contract failed (response body withheld)")
	}
	b = invoke("exec", "-T", "cert-watch", "sh", "-c", "openssl s_client -connect nginx:443 -alpn h2 </dev/null 2>&1")
	if !bytes.Contains(b, []byte("ALPN protocol: h2")) {
		t.Fatal("edge did not negotiate HTTP/2")
	}
	before := invoke("exec", "-T", "cert-watch", "openssl", "x509", "-in", "/etc/nginx/tls/server.pem", "-noout", "-fingerprint", "-sha256")
	invoke("restart", "server", "nginx")
	// Wait uses the same runtime no-pull/no-build policy after restarting the stack.
	invoke("up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180")
	after := invoke("exec", "-T", "cert-watch", "openssl", "x509", "-in", "/etc/nginx/tls/server.pem", "-noout", "-fingerprint", "-sha256")
	if !bytes.Equal(before, after) {
		t.Fatal("TLS fingerprint changed on restart")
	}
	if json.Unmarshal(edge("/identity/setup/status", ""), &status) != nil || !status.Initialized {
		t.Fatal("PostgreSQL user did not survive restart")
	}
	b = edge("/identity/auth/login", `{"email":"offline345@example.com","password":"fixturePassword345!"}`)
	if json.Unmarshal(b, &claim) != nil || claim.SessionToken == "" || claim.User.Role != "admin" {
		t.Fatal("login after restart failed")
	}
	for _, volume := range []string{"nevix_pgdata", "nevix_tls", "nevix_secrets"} {
		docker("volume", "inspect", volume)
	}
	for _, container := range strings.Fields(string(invoke("ps", "--quiet"))) {
		b = docker("inspect", container, "--format", "{{json .HostConfig.PortBindings}}")
		var bindings map[string]json.RawMessage
		if json.Unmarshal(b, &bindings) != nil || (len(bindings) > 0 && (len(bindings) != 1 || bindings["443/tcp"] == nil)) {
			t.Fatalf("unexpected published port: %s", b)
		}
	}
	exerciseCompleteInstanceBackup(t, dir, bundle, manifest, key, claim.SessionToken, invoke, docker)
	exerciseInstanceUpgrade(t, dir, bundle, invoke, docker)
	// Immutable runtime references cannot silently pull when a required local image disappears.
	invoke("down")
	var images []struct {
		ID string `json:"Id"`
	}
	if json.Unmarshal(docker("image", "inspect", "--platform", "linux/amd64", "nevix-bundle-cert-init:1.2.3"), &images) != nil || len(images) != 1 {
		t.Fatal("cert image missing")
	}
	docker("image", "rm", "--force", "nevix-bundle-cert-init:1.2.3", images[0].ID)
	cmd := exec.Command("docker", append(compose, "run", "--rm", "--no-deps", "--pull", "never", "cert-init")...)
	if b, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("missing immutable image unexpectedly started: %s", b)
	}
	t.Log("offline-first-install sentinel: real images, public HTTPS claim, HTTP/2, persistent data/TLS, missing image refusal; zero runtime pulls")
}
