package deployment_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/deployment"
)

func TestDeploymentProviderFixture(t *testing.T) {
	if os.Getenv("NEVIX_DEPLOY_PROVIDER_FIXTURE") != "1" {
		t.Skip("test-only provider subprocess")
	}
	if err := http.ListenAndServeTLS(":443", "/fixture/provider.pem", "/fixture/provider.key", newDeploymentProviderFixtureHandler()); err != nil {
		t.Fatal(err)
	}
}

func newDeploymentProviderFixtureHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/images/generations", func(w http.ResponseWriter, r *http.Request) {
		for {
			if _, e := os.Stat("/fixture/block-generation"); os.IsNotExist(e) {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		io.WriteString(w, `{"error":{"message":"controlled terminal provider refusal","type":"invalid_request_error"}}`)
	})
	var mu sync.Mutex
	type object struct {
		data                  []byte
		contentType, uploadID string
	}
	objects := map[string]object{}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "nevix-upgrade.oss-cn-hangzhou.aliyuncs.com" {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("x-oss-request-id", "isolated-upgrade-fixture")
		if r.Header.Get("Authorization") == "" && r.URL.Query().Get("x-oss-signature") == "" {
			w.WriteHeader(403)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		value, exists := objects[r.URL.Path]
		switch r.Method {
		case "PUT":
			if exists {
				w.WriteHeader(409)
				io.WriteString(w, `<Error><Code>FileAlreadyExists</Code><Message>exists</Message></Error>`)
				return
			}
			data, e := io.ReadAll(r.Body)
			if e != nil {
				w.WriteHeader(500)
				return
			}
			objects[r.URL.Path] = object{data, r.Header.Get("Content-Type"), r.Header.Get("x-oss-meta-upload-id")}
			w.Header().Set("ETag", `"fixture-etag"`)
			w.WriteHeader(200)
		case "DELETE":
			delete(objects, r.URL.Path)
			w.WriteHeader(204)
		case "GET", "HEAD":
			if !exists {
				missing := `<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>`
				// Real HEAD transport drops the body. OSS SDK v2 reads the
				// base64 XML error header to distinguish NoSuchKey from other 404s.
				if r.Method == http.MethodHead {
					w.Header().Set("X-Oss-Err", base64.StdEncoding.EncodeToString([]byte(missing)))
				}
				w.WriteHeader(404)
				io.WriteString(w, missing)
				return
			}
			w.Header().Set("Content-Type", value.contentType)
			w.Header().Set("x-oss-meta-upload-id", value.uploadID)
			w.Header().Set("ETag", `"fixture-etag"`)
			w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
			data := value.data
			if r.Header.Get("Range") != "" {
				var lo, hi int
				fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &lo, &hi)
				if lo < 0 || hi >= len(data) || hi < lo {
					w.WriteHeader(416)
					return
				}
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", lo, hi, len(data)))
				data = data[lo : hi+1]
				w.Header().Set("Content-Length", strconv.Itoa(len(data)))
				w.WriteHeader(206)
			} else {
				w.Header().Set("Content-Length", strconv.Itoa(len(data)))
				w.WriteHeader(200)
			}
			if r.Method != "HEAD" {
				w.Write(data)
			}
		default:
			w.WriteHeader(405)
		}
	})
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-provider-key-347" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"data":[]}`)
	})
	return mux
}

func providerCertificate(t *testing.T) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(347), Subject: pkix.Name{CommonName: "isolated provider fixture"}, DNSNames: []string{"models.kapon.cloud", "nevix-upgrade.oss-cn-hangzhou.aliyuncs.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private})
}
func exerciseCompleteInstanceBackup(t *testing.T, dir, bundle, manifest, key, token string, invoke, docker func(...string) []byte) {
	t.Helper()
	cert := invoke("exec", "-T", "cert-watch", "cat", "/etc/nginx/tls/server.pem")
	block, _ := pem.Decode(cert)
	if block == nil {
		t.Fatal("customer certificate absent")
	}
	pin := sha256.Sum256(block.Bytes)
	fingerprint := hex.EncodeToString(pin[:])
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(cert) {
		t.Fatal("customer TLS invalid")
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}}, Timeout: 15 * time.Second}
	request := func(method, path, session string, body any) (int, []byte) {
		t.Helper()
		var reader io.Reader
		if body != nil {
			b, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			reader = bytes.NewReader(b)
		}
		req, err := http.NewRequest(method, "https://127.0.0.1"+path, reader)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		if session != "" {
			req.Header.Set("Authorization", "Bearer "+session)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, b
	}
	private := t.TempDir()
	tokenFile := filepath.Join(private, "session")
	credentials := filepath.Join(private, "credentials.json")
	if err := os.WriteFile(tokenFile, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(credentials, []byte(`{"email":"offline345@example.com","password":"fixturePassword345!"}`), 0600); err != nil {
		t.Fatal(err)
	}
	base := []string{"--directory", dir, "--manifest", manifest, "--bundle", bundle, "--server-url", "https://127.0.0.1", "--tls-fingerprint", fingerprint}
	backupArgs := func(output string) []string {
		return append(append([]string{"backup"}, base...), "--token-file", tokenFile, "--output", output)
	}
	assertOpen := func() {
		t.Helper()
		status, b := request("GET", "/creation/maintenance", token, nil)
		if status != 200 || !bytes.Contains(b, []byte(`"paused":false`)) {
			t.Fatalf("backup did not recover own admission:: HTTP %d (response body withheld)", status)
		}
	}
	// Trust and authorization failures must leave the existing business instance open.
	wrongPin := backupArgs(filepath.Join(private, "wrong-pin.tar.gz"))
	for i := range wrongPin {
		if wrongPin[i] == fingerprint {
			wrongPin[i] = strings.Repeat("a", 64)
		}
	}
	if err := deployment.Run(wrongPin, key); err == nil || !strings.Contains(err.Error(), "tls-pin") {
		t.Fatalf("changed customer TLS pin must identify trust failure without private transport bytes: %v", err)
	}
	assertOpen()
	if err := os.WriteFile(tokenFile, []byte("invalid-session"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := deployment.Run(backupArgs(filepath.Join(private, "bad-session.tar.gz")), key); err == nil {
		t.Fatal("invalid session accepted")
	}
	assertOpen()
	if err := os.WriteFile(tokenFile, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	unconfigured := filepath.Join(private, "unconfigured.tar.gz")
	if err := deployment.Run(backupArgs(unconfigured), key); err != nil {
		t.Fatal("legitimately absent master key backup:", err)
	}
	assertOpen()
	// Establish real encrypted credentials via public Admin reauthentication and provider HTTP.
	fixture := t.TempDir()
	providerCert, providerKey := providerCertificate(t)
	for name, b := range map[string][]byte{"provider.pem": providerCert, "provider.key": providerKey} {
		mode := os.FileMode(0600)
		if name == "provider.pem" {
			mode = 0644
		} // Public CA must be readable by the unprivileged Server.
		if err := os.WriteFile(filepath.Join(fixture, name), b, mode); err != nil {
			t.Fatal(err)
		}
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	binaryBytes, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(fixture, "deployment.test"), binaryBytes, 0755); err != nil {
		t.Fatal(err)
	}
	docker("run", "--detach", "--name", "nevix-provider-fixture-347", "--pull", "never", "--network", "nevix_internal", "--network-alias", "models.kapon.cloud", "--mount", "type=bind,source="+fixture+",target=/fixture,readonly", "--env", "NEVIX_DEPLOY_PROVIDER_FIXTURE=1", "--entrypoint", "/fixture/deployment.test", "nevix-bundle-cert-init:1.2.3", "-test.run=^TestDeploymentProviderFixture$")
	defer docker("rm", "--force", "nevix-provider-fixture-347")
	serverID := strings.TrimSpace(string(invoke("ps", "--quiet", "server")))
	docker("cp", filepath.Join(fixture, "provider.pem"), serverID+":/etc/ssl/certs/isolated-provider-fixture.pem")
	invoke("exec", "-T", "server", "test", "-r", "/etc/ssl/certs/isolated-provider-fixture.pem")
	// Install the public CA before a fresh process loads system roots, including
	// a future configured Release startup probe. Private fixture key stays 0600.
	invoke("restart", "server")
	invoke("up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180")
	status, b := request("POST", "/identity/admin/reauth/proofs", token, map[string]string{"action": "provider_connection.create", "password": "fixturePassword345!"})
	var proof struct {
		Proof     string    `json:"proof"`
		Action    string    `json:"action"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if status != http.StatusOK || json.Unmarshal(b, &proof) != nil || proof.Proof == "" || proof.Action != "provider_connection.create" || !proof.ExpiresAt.After(time.Now()) {
		t.Fatalf("real reauth:: HTTP %d (response body withheld)", status)
	}
	status, b = request("POST", "/creation/provider-connection", token, map[string]string{"proof": proof.Proof, "provider_key": "fixture-provider-key-347"})
	if status != 201 {
		t.Fatalf("real encrypted provider configure:: HTTP %d (response body withheld)", status)
	}
	before := invoke("exec", "-T", "cert-watch", "openssl", "x509", "-in", "/etc/nginx/tls/server.pem", "-noout", "-fingerprint", "-sha256")
	status, b = request("PATCH", "/identity/users/me", token, map[string]string{"display_name": "Backed up business identity"})
	if status != 200 {
		t.Fatalf("business fixture: HTTP %d (response body withheld)", status)
	}
	output := filepath.Join(private, "complete.tar.gz")
	if err = deployment.Run(backupArgs(output), key); err != nil {
		t.Fatal(err)
	}
	assertOpen()
	if st, e := os.Stat(output); e != nil || st.Mode().Perm() != 0600 {
		t.Fatal("backup custody permissions")
	}
	// A permission-damaged key must abort before replacement and resume the old instance.
	invoke("exec", "-T", "--user", "root", "server", "chmod", "0644", "/var/lib/nevix/secrets/provider-credential-master.key")
	if e := deployment.Run(backupArgs(filepath.Join(private, "bad-key.tar.gz")), key); e == nil {
		t.Fatal("damaged key backup succeeded")
	}
	assertOpen()
	invoke("exec", "-T", "--user", "root", "server", "chmod", "0600", "/var/lib/nevix/secrets/provider-credential-master.key")
	// Preserve existing pauses; commands may never adopt another operation's owner token.
	status, b = request("GET", "/creation/maintenance", token, nil)
	var maintenance struct {
		Revision int64 `json:"revision"`
	}
	if status != 200 || json.Unmarshal(b, &maintenance) != nil {
		t.Fatal("maintenance read")
	}
	owner := "0d0c3470-0000-4000-8000-000000000347"
	status, b = request("POST", "/creation/maintenance/pause", token, map[string]any{"owner_token": owner, "expected_revision": maintenance.Revision})
	if status != 200 {
		t.Fatal("external pause fixture")
	}
	json.Unmarshal(b, &maintenance)
	if e := deployment.Run(backupArgs(filepath.Join(private, "other-owner.tar.gz")), key); e == nil {
		t.Fatal("backup stole existing maintenance")
	}
	status, b = request("GET", "/creation/maintenance", token, nil)
	if status != 200 || !bytes.Contains(b, []byte(owner)) {
		t.Fatal("backup changed other owner's pause")
	}
	status, _ = request("POST", "/creation/maintenance/resume", token, map[string]any{"owner_token": owner, "expected_revision": maintenance.Revision})
	if status != 200 {
		t.Fatal("external resume fixture")
	}
	// New writes and sessions disappear on explicit restore; recovery authenticates a fresh session.
	status, b = request("PATCH", "/identity/users/me", token, map[string]string{"display_name": "Post-backup write to discard"})
	if status != 200 {
		t.Fatalf("post backup business write: HTTP %d (response body withheld)", status)
	}
	status, b = request("POST", "/identity/auth/logout", token, map[string]string{})
	if status != http.StatusOK || !bytes.Contains(b, []byte(`"status":"logged_out"`)) {
		t.Fatalf("original session revoke: HTTP %d (response body withheld)", status)
	}
	status, b = request("POST", "/identity/auth/login", "", map[string]string{"email": "offline345@example.com", "password": "fixturePassword345!"})
	var newer struct {
		Token string `json:"token"`
	}
	if status != 200 || json.Unmarshal(b, &newer) != nil || newer.Token == "" {
		t.Fatal("new postbackup session")
	}
	recoverArgs := append(append([]string{"verify-backup"}, base...), "--credentials-file", credentials, "--backup", output)
	if err = deployment.Run(recoverArgs, key); err != nil {
		t.Fatal("historical-token-independent isolated verification:", err)
	}
	restoreArgs := append(append([]string{"restore"}, base...), "--credentials-file", credentials, "--backup", output)
	if err = deployment.Run(restoreArgs, key); err == nil {
		t.Fatal("restore without explicit loss confirmation succeeded")
	}
	status, b = request("GET", "/identity/users/me", newer.Token, nil)
	if status != 200 || !bytes.Contains(b, []byte("Post-backup write to discard")) {
		t.Fatal("unconfirmed restore changed data")
	}
	restoreArgs = append(restoreArgs, "--confirm", "RESTORE-LOSE-POST-BACKUP-WRITES")
	if err = deployment.Run(restoreArgs, key); err != nil {
		t.Fatal("explicit complete restore:", err)
	}
	// Restored-container checks read retained Identity/admission state only.
	// The subsequent upgrade fixture installs its own CA before any SDK call.
	after := invoke("exec", "-T", "cert-watch", "openssl", "x509", "-in", "/etc/nginx/tls/server.pem", "-noout", "-fingerprint", "-sha256")
	if !bytes.Equal(before, after) {
		t.Fatal("restore changed customer TLS identity")
	}
	status, b = request("POST", "/identity/auth/login", "", map[string]string{"email": "offline345@example.com", "password": "fixturePassword345!"})
	if status != 200 || json.Unmarshal(b, &newer) != nil {
		t.Fatal("restored login")
	}
	status, b = request("GET", "/identity/users/me", newer.Token, nil)
	if status != 200 || !bytes.Contains(b, []byte("Backed up business identity")) {
		t.Fatal("business data was not restored")
	}
	status, b = request("GET", "/creation/maintenance", newer.Token, nil)
	if status != 200 || !bytes.Contains(b, []byte(`"paused":false`)) {
		t.Fatal("verified restore did not resume admission")
	}
	t.Log("complete-instance-restore sentinel: real Admin HTTPS, encrypted provider/master-key AEAD, logical PG restore, private config/TLS, old-session independence, explicit postbackup data loss, owned-pause failure recovery")
}

// Only canonical public codes can leave a failed credential-command response.
// Unknown JSON (including tokens/proofs) is never interpolated into test logs.
func fixtureCreationErrorCode(body []byte) string {
	var response struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &response) != nil {
		return "not-json"
	}
	switch response.Error {
	case "provider_check_temporarily_unavailable", "provider_credential_invalid", "object_storage_unavailable", "internal_error", "invalid_request", "unauthorized", "forbidden", "password_change_required", "reauth_proof_invalid", "reauth_proof_expired", "reauth_proof_action_mismatch", "reauth_proof_already_consumed", "secure_transport_required":
		return response.Error
	default:
		return "unrecognized"
	}
}
