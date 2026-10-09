package deployment_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/deployment"
	"github.com/nevix-ai/server/internal/release"
)

func exerciseInstanceUpgrade(t *testing.T, dir, originalBundle string, invoke, docker func(...string) []byte) {
	t.Helper()
	fixtures := os.Getenv("NEVIX_DEPLOY_UPGRADE_FIXTURES")
	if fixtures == "" {
		t.Fatal("native signed upgrade fixtures required")
	}
	cert := invoke("exec", "-T", "cert-watch", "cat", "/etc/nginx/tls/server.pem")
	block, _ := pem.Decode(cert)
	if block == nil {
		t.Fatal("customer cert")
	}
	pin := sha256.Sum256(block.Bytes)
	fingerprint := hex.EncodeToString(pin[:])
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(cert)
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}}, Timeout: 15 * time.Second}
	defer client.CloseIdleConnections()
	request := func(method, path, token string, body any) (int, []byte) {
		t.Helper()
		var reader io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			reader = bytes.NewReader(b)
		}
		r, e := http.NewRequest(method, "https://127.0.0.1"+path, reader)
		if e != nil {
			t.Fatal(e)
		}
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+token)
		res, e := client.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		b, e := io.ReadAll(res.Body)
		if e != nil {
			t.Fatal(e)
		}
		return res.StatusCode, b
	}
	status, b := request("POST", "/identity/auth/login", "", map[string]string{"email": "offline345@example.com", "password": "fixturePassword345!"})
	var session struct {
		Token string `json:"token"`
	}
	if status != 200 || json.Unmarshal(b, &session) != nil || session.Token == "" {
		t.Fatalf("upgrade real login: HTTP %d (response body withheld)", status)
	}
	token := session.Token
	private := t.TempDir()
	tokenFile := filepath.Join(private, "session")
	os.WriteFile(tokenFile, []byte(token), 0600)
	credentials := filepath.Join(private, "credentials.json")
	os.WriteFile(credentials, []byte(`{"email":"offline345@example.com","password":"fixturePassword345!"}`), 0600)
	pub, priv, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	der, e := x509.MarshalPKIXPublicKey(pub)
	if e != nil {
		t.Fatal(e)
	}
	key := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	sign := func(bundle, version string) string {
		t.Helper()
		data, e := os.ReadFile(bundle)
		if e != nil {
			t.Fatal(e)
		}
		sum := sha512.Sum512(data)
		payload, e := json.Marshal(release.Manifest{Version: version, Channel: "stable", Platform: "linux", Arch: "amd64", MinServerVersion: "1.0.0", MinDesktopVersion: "1.0.0", URL: "https://example.com/" + version + ".tar.gz", Size: int64(len(data)), SHA512: base64.StdEncoding.EncodeToString(sum[:])})
		if e != nil {
			t.Fatal(e)
		}
		envelope, _ := json.Marshal(map[string]string{"format": "nevix-release-v1", "payload": base64.StdEncoding.EncodeToString(payload), "signature": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))})
		path := filepath.Join(private, version+".json")
		if e = os.WriteFile(path, envelope, 0600); e != nil {
			t.Fatal(e)
		}
		return path
	}
	originalManifest := sign(originalBundle, "1.2.3")
	successBundle := filepath.Join(fixtures, "success.tar.gz")
	successManifest := sign(successBundle, "1.2.4")
	base := []string{"--directory", dir, "--server-url", "https://127.0.0.1", "--tls-fingerprint", fingerprint, "--token-file", tokenFile}
	args := func(candidate, manifest, original, oldManifest, output string) []string {
		return append(append([]string{"upgrade"}, base...), "--bundle", candidate, "--manifest", manifest, "--original-bundle", original, "--original-manifest", oldManifest, "--backup", output)
	}
	assertOpenOld := func(version string) {
		t.Helper()
		s, data := request("GET", "/creation/maintenance", token, nil)
		if s != 200 || !bytes.Contains(data, []byte(`"paused":false`)) {
			t.Fatalf("pre-replacement failure did not recover owned pause:: HTTP %d (response body withheld)", s)
		}
		s, data = request("GET", "/release/version", token, nil)
		if s != 200 || !bytes.Contains(data, []byte(`"version":"`+version+`"`)) {
			t.Fatalf("source release changed before replacement:: HTTP %d (response body withheld)", s)
		}
	}
	// Real private key damage aborts backup before replacement; source runtime must resume.
	invoke("exec", "-T", "--user", "root", "server", "chmod", "0644", "/var/lib/nevix/secrets/provider-credential-master.key")
	if e = deployment.Run(args(successBundle, successManifest, originalBundle, originalManifest, filepath.Join(private, "damaged-key.tar.gz")), key); e == nil {
		t.Fatal("upgrade with unrecoverable private key accepted")
	}
	assertOpenOld("1.2.3")
	invoke("exec", "-T", "--user", "root", "server", "chmod", "0600", "/var/lib/nevix/secrets/provider-credential-master.key")
	// Provider and OSS are external HTTPS collaborators, never production overrides.
	fixture := t.TempDir()
	providerCert, providerKey := providerCertificate(t)
	for name, data := range map[string][]byte{"provider.pem": providerCert, "provider.key": providerKey} {
		mode := os.FileMode(0600)
		if name == "provider.pem" {
			mode = 0644
		} // Public CA, separate from the 0600 private key.
		if err := os.WriteFile(filepath.Join(fixture, name), data, mode); err != nil {
			t.Fatal(err)
		}
	}
	binary, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	data, e := os.ReadFile(binary)
	if e != nil {
		t.Fatal(e)
	}
	os.WriteFile(filepath.Join(fixture, "deployment.test"), data, 0755)
	docker("run", "--detach", "--name", "nevix-provider-fixture-348", "--pull", "never", "--network", "nevix_internal", "--network-alias", "models.kapon.cloud", "--network-alias", "nevix-upgrade.oss-cn-hangzhou.aliyuncs.com", "--mount", "type=bind,source="+fixture+",target=/fixture,readonly", "--env", "NEVIX_DEPLOY_PROVIDER_FIXTURE=1", "--entrypoint", "/fixture/deployment.test", "nevix-bundle-cert-init:1.2.3", "-test.run=^TestDeploymentProviderFixture$")
	defer docker("rm", "--force", "nevix-provider-fixture-348")
	trustProvider := func() {
		id := strings.TrimSpace(string(invoke("ps", "--quiet", "server")))
		docker("cp", filepath.Join(fixture, "provider.pem"), id+":/etc/ssl/certs/isolated-provider-fixture.pem")
		invoke("exec", "-T", "server", "test", "-r", "/etc/ssl/certs/isolated-provider-fixture.pem")
	}
	trustProvider()
	invoke("restart", "server")
	invoke("up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180")
	invoke("restart", "nginx")
	// A Docker restart acknowledgement does not establish fresh HTTPS readiness.
	// Discard connections to the old edge and retry only this anonymous read;
	// the following proof-issuance command is sent exactly once.
	edgeDeadline := time.Now().Add(20 * time.Second)
	edgeCtx, edgeCancel := context.WithDeadline(context.Background(), edgeDeadline)
	defer edgeCancel()
	for {
		client.CloseIdleConnections()
		probe, err := http.NewRequestWithContext(edgeCtx, http.MethodGet, "https://127.0.0.1/release/version", nil)
		if err != nil {
			t.Fatal("fixture readiness request construction failed")
		}
		res, err := client.Do(probe)
		status := 0
		var data []byte
		if err == nil {
			status = res.StatusCode
			data, err = io.ReadAll(io.LimitReader(res.Body, 64*1024+1))
			res.Body.Close()
		}
		if err == nil && status == http.StatusOK {
			var running struct {
				Service string `json:"service"`
				Version string `json:"version"`
			}
			if len(data) > 64*1024 || json.Unmarshal(data, &running) != nil || running.Service != "nevix-server" || running.Version != "1.2.3" {
				t.Fatal("restarted fixture HTTPS returned a different release identity")
			}
			break
		}
		if (status != 0 && status != http.StatusBadGateway && status != http.StatusServiceUnavailable) || time.Now().After(edgeDeadline) {
			t.Fatalf("restarted fixture HTTPS release read unavailable: HTTP %d (private transport and response bytes withheld)", status)
		}
		time.Sleep(100 * time.Millisecond)
	}
	edgeCancel()
	status, b = request("POST", "/identity/admin/reauth/proofs", token, map[string]string{"action": "object_storage_connection.create", "password": "fixturePassword345!"})
	var proof struct {
		Proof     string    `json:"proof"`
		Action    string    `json:"action"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if status != http.StatusOK || json.Unmarshal(b, &proof) != nil || proof.Proof == "" || proof.Action != "object_storage_connection.create" || !proof.ExpiresAt.After(time.Now()) {
		t.Fatalf("storage reauth: HTTP %d (response body withheld)", status)
	}
	status, b = request("POST", "/creation/object-storage-connection", token, map[string]string{"proof": proof.Proof, "provider": "oss", "region": "cn-hangzhou", "bucket": "nevix-upgrade", "access_key_id": "fixture-access-key-348", "secret_access_key": "fixture-secret-key-348"})
	if status != 201 {
		t.Fatalf("real OSS adapter against isolated HTTPS collaborator: HTTP %d code=%s (response body withheld)", status, fixtureCreationErrorCode(b))
	}
	submit := func(idempotency string) (string, string) {
		t.Helper()
		status, b = request("POST", "/creation/sessions", token, map[string]string{"name": "Retained upgrade task"})
		var s struct {
			ID string `json:"id"`
		}
		if status != 201 || json.Unmarshal(b, &s) != nil {
			t.Fatalf("session: HTTP %d (response body withheld)", status)
		}
		status, b = request("GET", "/creation/capability-manifest", token, nil)
		var manifest struct {
			Version int `json:"manifest_version"`
		}
		if status != 200 || json.Unmarshal(b, &manifest) != nil {
			t.Fatal("manifest")
		}
		os.WriteFile(filepath.Join(fixture, "block-generation"), nil, 0600)
		status, b = request("POST", "/creation/sessions/"+s.ID+"/tasks", token, map[string]any{"idempotency_key": idempotency, "manifest_version": manifest.Version, "media_type": "image", "model": "doubao-seedream-5.0-pro", "mode": "text-to-image", "prompt": "Queued before upgrade", "ratio": "1:1", "resolution": "2K", "quantity": 1, "references": []any{}})
		var task struct {
			Task struct {
				ID string `json:"id"`
			} `json:"task"`
		}
		if status != 201 || json.Unmarshal(b, &task) != nil || task.Task.ID == "" {
			t.Fatalf("real task admission: HTTP %d (response body withheld)", status)
		}
		return s.ID, task.Task.ID
	}
	_, task := submit("timeout-348")
	timeoutArgs := append(args(successBundle, successManifest, originalBundle, originalManifest, filepath.Join(private, "timeout.tar.gz")), "--drain-timeout", "500ms")
	if e = deployment.Run(timeoutArgs, key); e == nil || !strings.Contains(e.Error(), "drain timed out") {
		t.Fatalf("real nonterminal task timeout before replacement: %v", e)
	}
	assertOpenOld("1.2.3")
	os.Remove(filepath.Join(fixture, "block-generation"))
	awaitTerminal := func(task string) {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for {
			status, b = request("GET", "/creation/tasks/"+task, token, nil)
			var v struct {
				Task struct {
					Status string `json:"status"`
				} `json:"task"`
			}
			if status == 200 && json.Unmarshal(b, &v) == nil && (v.Task.Status == "failed" || v.Task.Status == "succeeded" || v.Task.Status == "cancelled") {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("actual worker did not drain terminal task:: HTTP %d (response body withheld)", status)
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	awaitTerminal(task)

	// Renaming the already-open backup parent before finalization must abort before replacement.
	_, task = submit("backup-parent-durability-348")
	backupDir := filepath.Join(private, "archive-parent")
	if e = os.Mkdir(backupDir, 0700); e != nil {
		t.Fatal(e)
	}
	parentFailure := make(chan error, 1)
	go func() {
		parentFailure <- deployment.Run(args(successBundle, successManifest, originalBundle, originalManifest, filepath.Join(backupDir, "backup.tar.gz")), key)
	}()
	parentDeadline := time.Now().Add(30 * time.Second)
	for {
		status, b = request("GET", "/creation/maintenance", token, nil)
		if status == 200 && bytes.Contains(b, []byte(`"paused":true`)) {
			break
		}
		select {
		case e := <-parentFailure:
			t.Fatalf("backup-parent fixture finished too early: %v", e)
		default:
		}
		if time.Now().After(parentDeadline) {
			t.Fatal("backup-parent pause not observed")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if e = os.Rename(backupDir, backupDir+"-renamed"); e != nil {
		t.Fatal(e)
	}
	os.Remove(filepath.Join(fixture, "block-generation"))
	if e = <-parentFailure; e == nil {
		t.Fatal("backup directory entry was not proven durable before replacement")
	}
	assertOpenOld("1.2.3")
	awaitTerminal(task)
	// A transparent external Docker wrapper fences the real stop call, permitting one valid
	// public rename after initial drain/capture and before the actual snapshot boundary.
	realDocker, e := exec.LookPath("docker")
	if e != nil {
		t.Fatal(e)
	}
	wrapperDir := t.TempDir()
	stopReady := filepath.Join(private, "stop-ready")
	stopBlock := filepath.Join(private, "stop-block")
	script := fmt.Sprintf("#!/usr/bin/env bash\nset -eu\ncase \"$*\" in *' stop --timeout 60 server') if test -f %q; then touch %q; while test -f %q; do sleep 0.02; done; fi;; esac\nexec %q \"$@\"\n", stopBlock, stopReady, stopBlock, realDocker)
	if e = os.WriteFile(filepath.Join(wrapperDir, "docker"), []byte(script), 0700); e != nil {
		t.Fatal(e)
	}
	oldPath := os.Getenv("PATH")
	if e = os.Setenv("PATH", wrapperDir+string(os.PathListSeparator)+oldPath); e != nil {
		t.Fatal(e)
	}
	defer os.Setenv("PATH", oldPath)
	if e = os.WriteFile(stopBlock, nil, 0600); e != nil {
		t.Fatal(e)
	}
	defer os.Remove(stopBlock)
	_, task = submit("drain-348")
	successfulBackup := filepath.Join(private, "upgrade-1.2.3.tar.gz")
	done := make(chan error, 1)
	go func() {
		done <- deployment.Run(args(successBundle, successManifest, originalBundle, originalManifest, successfulBackup), key)
	}()
	deadline := time.Now().Add(30 * time.Second)
	for {
		status, b = request("GET", "/creation/maintenance", token, nil)
		if status == 200 && bytes.Contains(b, []byte(`"paused":true`)) && bytes.Contains(b, []byte(`"non_terminal_tasks":1`)) {
			break
		}
		select {
		case e := <-done:
			t.Fatalf("upgrade skipped real pending task drain: %v", e)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("owned pause with pending task not observed")
		}
		time.Sleep(100 * time.Millisecond)
	}
	os.Remove(filepath.Join(fixture, "block-generation"))
	stopDeadline := time.Now().Add(30 * time.Second)
	for {
		if _, e := os.Stat(stopReady); e == nil {
			break
		}
		select {
		case e := <-done:
			t.Fatalf("upgrade finished before fenced snapshot stop: %v", e)
		default:
		}
		if time.Now().After(stopDeadline) {
			t.Fatal("snapshot stop fence not reached")
		}
		time.Sleep(20 * time.Millisecond)
	}
	status, b = request("PATCH", "/identity/users/me", token, map[string]string{"display_name": "Valid rename at snapshot boundary"})
	if status != 200 {
		t.Fatalf("allowed pre-stop rename: HTTP %d (response body withheld)", status)
	}
	if e = os.Remove(stopBlock); e != nil {
		t.Fatal(e)
	}
	if e = <-done; e != nil {
		t.Fatal("complete real upgrade:", e)
	}
	// Every real Provider/OSS SDK call and held task finishes on the original
	// Server before replacement. The candidate/restore checks below observe
	// retained state and AEAD recovery; they issue no new collaborator request.
	assertOpenOld("1.2.4")
	status, b = request("GET", "/creation/tasks/"+task, token, nil)
	if status != 200 || !bytes.Contains(b, []byte("Queued before upgrade")) {
		t.Fatalf("historical task lost across real migration:: HTTP %d (response body withheld)", status)
	}

	// Reproduce a crash after resume committed but before journal completion. Legitimate
	// post-resume business writes and admission facts must survive non-destructive reconciliation.
	status, b = request("GET", "/creation/maintenance", token, nil)
	var resumed struct {
		Owner    string `json:"owner_token"`
		Revision int64  `json:"revision"`
	}
	if status != 200 || json.Unmarshal(b, &resumed) != nil || resumed.Owner == "" {
		t.Fatal("actual completed maintenance transition")
	}
	var beforeResume map[string]any
	if json.Unmarshal(b, &beforeResume) != nil {
		t.Fatal("resumed snapshot")
	}
	status, b = request("PATCH", "/identity/users/me", token, map[string]string{"display_name": "Legitimate post-resume business write"})
	if status != 200 {
		t.Fatal("post-resume business write")
	}
	for _, phase := range []string{"verified", "resume-intent", "complete"} {
		journal, _ := json.Marshal(map[string]any{"format": "nevix-upgrade-v1", "original_version": "1.2.3", "candidate_version": "1.2.4", "backup": successfulBackup, "phase": phase, "owner_token": resumed.Owner, "expected_revision": resumed.Revision - 1})
		if e = os.WriteFile(filepath.Join(dir, "upgrade.json"), journal, 0600); e != nil {
			t.Fatal(e)
		}
		recoverArgs := append(append([]string{"recover-upgrade"}, base...), "--original-bundle", originalBundle, "--original-manifest", originalManifest, "--bundle", successBundle, "--manifest", successManifest)
		if e = deployment.Run(recoverArgs, key); e != nil {
			t.Fatalf("non-destructive %s resume reconciliation: %v", phase, e)
		}
		status, b = request("GET", "/identity/users/me", token, nil)
		if status != 200 || !bytes.Contains(b, []byte("Legitimate post-resume business write")) {
			t.Fatal("resume recovery discarded valid business writes")
		}
		status, b = request("GET", "/creation/maintenance", token, nil)
		var afterResume map[string]any
		if status != 200 || json.Unmarshal(b, &afterResume) != nil || !reflect.DeepEqual(beforeResume, afterResume) {
			t.Fatal("resume reconciliation repeated or replaced maintenance transition")
		}
		if _, e = os.Stat(filepath.Join(dir, "upgrade.json")); !os.IsNotExist(e) {
			t.Fatal("completed reconciliation journal retained")
		}
	}
	// External release faults exercise actual Goose failure and actual Docker health outcome.
	for _, fault := range []struct{ name, version string }{{"migration-failure", "1.2.5"}, {"health-failure", "1.2.6"}} {
		bundle := filepath.Join(fixtures, fault.name+".tar.gz")
		manifest := sign(bundle, fault.version)
		backup := filepath.Join(private, fault.name+".backup.tar.gz")
		if e = deployment.Run(args(bundle, manifest, successBundle, successManifest, backup), key); e == nil || !strings.Contains(e.Error(), "replacement failed") {
			t.Fatalf("actual %s failure accepted: %v", fault.name, e)
		}
		if st, e := os.Stat(backup); e != nil || st.Mode().Perm() != 0600 {
			t.Fatal("postreplacement failure lost private proven backup")
		}
		if b = invoke("ps", "--status", "running", "--quiet", "server"); len(bytes.TrimSpace(b)) != 0 {
			t.Fatal("failed replacement Server automatically reopened")
		}
		if b = invoke("ps", "--status", "running", "--quiet", "nginx"); len(bytes.TrimSpace(b)) != 0 {
			t.Fatal("failed replacement edge automatically reopened")
		}
		if fault.name == "health-failure" {
			id := strings.TrimSpace(string(invoke("ps", "--all", "--quiet", "server")))
			state := docker("inspect", id, "--format", "{{.State.Health.Status}}")
			if strings.TrimSpace(string(state)) != "unhealthy" {
				t.Fatalf("health failure was not actual Docker unhealthy outcome: %s", state)
			}
		}
		logs := invoke("logs", "--no-color", "server")
		if fault.name == "migration-failure" && !bytes.Contains(logs, []byte("division by zero")) {
			t.Fatal("migration failure was not actual PostgreSQL Goose failure")
		}
		restore := append([]string{"restore", "--directory", dir, "--bundle", successBundle, "--manifest", successManifest, "--backup", backup, "--server-url", "https://127.0.0.1", "--tls-fingerprint", fingerprint, "--credentials-file", credentials}, "--confirm", "RESTORE-LOSE-POST-BACKUP-WRITES")
		if e = deployment.Run(restore, key); e != nil {
			t.Fatalf("explicit consistent recovery after %s: %v", fault.name, e)
		}
		status, b = request("POST", "/identity/auth/login", "", map[string]string{"email": "offline345@example.com", "password": "fixturePassword345!"})
		if status != 200 || json.Unmarshal(b, &session) != nil {
			t.Fatal("restored fresh Admin login")
		}
		token = session.Token
		os.WriteFile(tokenFile, []byte(token), 0600)
		assertOpenOld("1.2.4")
	}
	t.Log("instance-upgrade sentinel: real signed old/new images, supplied pinned Admin HTTPS, queued-task timeout/drain, recoverable complete backup, actual additive Goose migration, retained history/config/TLS/master-key/encrypted credentials, actual failing SQL/health, stopped persistent maintenance, explicit consistent restore")
}
