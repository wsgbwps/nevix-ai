package deployment_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nevix-ai/server/internal/release"

	"github.com/nevix-ai/server/internal/deployment"
)

func TestUntrustedBundleCannotCreateInstallation(t *testing.T) {
	dir := t.TempDir()
	envelope := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(envelope, []byte(`{"format":"nevix-release-v1","payload":"e30=","signature":""}`), 0600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(dir, "instance")
	err := deployment.Run([]string{"import", "--manifest", envelope, "--bundle", filepath.Join(dir, "missing.tar.gz"), "--directory", destination}, "")
	if err == nil || !strings.Contains(err.Error(), "signed release") {
		t.Fatalf("expected trust refusal, got %v", err)
	}
	if _, err = os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("untrusted installation directory was created: %v", err)
	}
}

func signedArchive(t *testing.T, name string, content []byte) (string, string, string) {
	t.Helper()
	dir := t.TempDir()
	bundle := filepath.Join(dir, "release.tar.gz")
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bundle, b.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha512.Sum512(b.Bytes())
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	key := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	payload, err := json.Marshal(release.Manifest{Version: "1.2.3", Channel: "stable", Platform: "linux", Arch: "amd64", MinServerVersion: "1.0.0", MinDesktopVersion: "1.0.0", URL: "https://example.com/release.tar.gz", Size: int64(b.Len()), SHA512: base64.StdEncoding.EncodeToString(sum[:])})
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(struct {
		Format    string `json:"format"`
		Payload   string `json:"payload"`
		Signature string `json:"signature"`
	}{"nevix-release-v1", base64.StdEncoding.EncodeToString(payload), base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))})
	if err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(manifest, envelope, 0600); err != nil {
		t.Fatal(err)
	}
	return bundle, manifest, key
}

func TestSignedHostileArchiveCannotEscapeInstallation(t *testing.T) {
	bundle, manifest, key := signedArchive(t, "../escape", []byte("untrusted script"))
	destination := filepath.Join(t.TempDir(), "instance")
	err := deployment.Run([]string{"import", "--manifest", manifest, "--bundle", bundle, "--directory", destination}, key)
	if err == nil || !strings.Contains(err.Error(), "archive entry") {
		t.Fatalf("expected archive rejection: %v", err)
	}
	if _, err = os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("created rejected installation: %v", err)
	}
}

func TestReplacedSignedBundleFailsBeforeExtraction(t *testing.T) {
	bundle, manifest, key := signedArchive(t, "bundle.json", []byte("{}"))
	if err := os.WriteFile(bundle, []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	err := deployment.Run([]string{"verify", "--manifest", manifest, "--bundle", bundle}, key)
	if err == nil || !strings.Contains(err.Error(), "digest or size") {
		t.Fatalf("expected artifact rejection: %v", err)
	}
}

// Every release fixture key is generated here; the production entry point has no override.
func signFile(t *testing.T, bundle string, versions ...string) (string, string) {
	version := "1.2.3"
	if len(versions) > 0 {
		version = versions[0]
	}
	t.Helper()
	b, err := os.ReadFile(bundle)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha512.Sum512(b)
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	key := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	payload, err := json.Marshal(release.Manifest{Version: version, Channel: "stable", Platform: "linux", Arch: "amd64", MinServerVersion: "1.0.0", MinDesktopVersion: "1.0.0", URL: "https://example.com/release.tar.gz", Size: int64(len(b)), SHA512: base64.StdEncoding.EncodeToString(sum[:])})
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(struct {
		Format    string `json:"format"`
		Payload   string `json:"payload"`
		Signature string `json:"signature"`
	}{"nevix-release-v1", base64.StdEncoding.EncodeToString(payload), base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))})
	if err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(t.TempDir(), "manifest.json")
	if err = os.WriteFile(manifest, envelope, 0600); err != nil {
		t.Fatal(err)
	}
	return manifest, key
}

func readRuntimeTemplate(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("../../../deploy/runtime-compose.template.yaml")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func fixtureBundle(t *testing.T) string {
	t.Helper()
	inputs := t.TempDir()
	files := map[string][]byte{"deploy/runtime-compose.template.yaml": readRuntimeTemplate(t), "deploy/.env.example": []byte("example only"), "deploy/nginx/nginx.conf": []byte("nginx"), "deploy/postgres/init-identity-app.sh": []byte("init"), "tools/nevix-deploy": []byte("tool"), "deploy/offline-install.md": []byte("manual")}
	var archive bytes.Buffer
	tw := tar.NewWriter(&archive)
	add := func(name string, b []byte) {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: int64(len(b)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(b); err != nil {
			t.Fatal(err)
		}
	}
	blob := func(b []byte) string {
		sum := sha256.Sum256(b)
		digest := "sha256:" + hex.EncodeToString(sum[:])
		add("blobs/sha256/"+strings.TrimPrefix(digest, "sha256:"), b)
		return digest
	}
	layer := []byte("known layer content")
	layerID := blob(layer)
	descriptors := []map[string]any{}
	saved := []map[string]any{}
	for _, service := range []string{"server", "cert-init", "postgres", "nginx"} {
		config, _ := json.Marshal(map[string]any{"architecture": "amd64", "os": "linux", "config": map[string]any{"service": service}, "rootfs": map[string]any{"diff_ids": []string{layerID}}})
		configID := blob(config)
		manifest, _ := json.Marshal(map[string]any{"schemaVersion": 2, "config": map[string]any{"digest": configID, "size": len(config)}, "layers": []map[string]any{{"digest": layerID, "size": len(layer)}}})
		manifestID := blob(manifest)
		tag := "nevix-bundle-" + service + ":1.2.3"
		descriptors = append(descriptors, map[string]any{"digest": manifestID, "size": len(manifest), "platform": map[string]any{"os": "linux", "architecture": "amd64"}, "annotations": map[string]any{"io.containerd.image.name": "docker.io/library/" + tag}})
		saved = append(saved, map[string]any{"Config": "blobs/sha256/" + strings.TrimPrefix(configID, "sha256:"), "RepoTags": []string{tag}, "Layers": []string{"blobs/sha256/" + strings.TrimPrefix(layerID, "sha256:")}})
	}
	index, _ := json.Marshal(map[string]any{"schemaVersion": 2, "manifests": descriptors})
	add("index.json", index)
	dockerManifest, _ := json.Marshal(saved)
	add("manifest.json", dockerManifest)
	add("oci-layout", []byte(`{"imageLayoutVersion":"1.0.0"}`))
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	files["images.tar"] = archive.Bytes()
	for name, b := range files {
		path := filepath.Join(inputs, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	output := filepath.Join(t.TempDir(), "bundle.tar.gz")
	err := deployment.Run([]string{"pack", "--inputs", inputs, "--version", "1.2.3", "--min-desktop-version", "1.0.0", "--min-server-version", "1.0.0", "--source-commit", strings.Repeat("a", 40), "--output", output}, "")
	if err != nil {
		t.Fatal(err)
	}
	return output
}

func TestCompleteSignedBundleVerifiesWithoutDockerOrHostCryptoTools(t *testing.T) {
	bundle := fixtureBundle(t)
	manifest, key := signFile(t, bundle)
	t.Setenv("PATH", t.TempDir())
	if err := deployment.Run([]string{"verify", "--manifest", manifest, "--bundle", bundle}, key); err != nil {
		t.Fatal(err)
	}
}

func TestShippedCLIHasNoRuntimePublisherKeyOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nevix-deploy")
	cmd := exec.Command("go", "build", "-o", path, "../../cmd/nevix-deploy")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, b)
	}
	bundle := fixtureBundle(t)
	manifest, key := signFile(t, bundle)
	cmd = exec.Command(path, "verify", "--manifest", manifest, "--bundle", bundle)
	cmd.Env = append(os.Environ(), "NEVIX_RELEASE_PUBLIC_KEY="+key)
	b, err := cmd.CombinedOutput()
	if err == nil || !bytes.Contains(b, []byte("signed release")) {
		t.Fatalf("production CLI accepted injected test key: %v %s", err, b)
	}
}

func TestBuiltRealBundleVerifies(t *testing.T) {
	bundle := os.Getenv("NEVIX_DEPLOY_VERIFY_BUNDLE")
	if bundle == "" {
		t.Skip("set real vendor-built bundle for local export verification")
	}
	manifest, key := signFile(t, bundle, "1.2.345")
	if err := deployment.Run([]string{"verify", "--manifest", manifest, "--bundle", bundle}, key); err != nil {
		t.Fatal(err)
	}
}
