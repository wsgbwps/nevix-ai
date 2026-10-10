package release_test

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"testing"

	"github.com/nevix-ai/server/internal/release"
)

func TestSameNodeSignatureVector(t *testing.T) {
	b, err := os.ReadFile("../../../scripts/release-feasibility/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		PublicKey string          `json:"publicKey"`
		Envelope  json.RawMessage `json:"envelope"`
	}
	if err = json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err = json.Compact(&compact, v.Envelope); err != nil {
		t.Fatal(err)
	}
	v.Envelope = compact.Bytes()
	got, err := release.Verify(v.Envelope, v.PublicKey, "win32", "x64")
	if err != nil || got.Version != "1.0.1" {
		t.Fatalf("vector rejected: %v %+v", err, got)
	}
	if _, err = release.Verify(v.Envelope, v.PublicKey, "linux", "amd64"); err == nil {
		t.Fatal("wrong architecture accepted")
	}
}

func TestSignedArtifactURLAmbiguityRejected(t *testing.T) {
	_, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(private.Public())
	if err != nil {
		t.Fatal(err)
	}
	public := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	for _, url := range []string{"https://@example.invalid/nevix.exe", "https://:@example.invalid/nevix.exe", "https://example.invalid/nevix%2Eexe", "https://example.invalid:65536/nevix.exe", "https:////example.invalid/nevix.exe", "https://example.invalid/bad%zz/nevix.exe", "https://%65xample.invalid/nevix.exe", "https://[fe80::1%25eth0]/nevix.exe"} {
		payload := []byte(`{"version":"1.0.1","channel":"stable","platform":"win32","arch":"x64","min_server_version":"1.0.0","min_desktop_version":"1.0.0","url":"` + url + `","size":1,"sha512":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="}`)
		envelope, _ := json.Marshal(struct {
			Format    string `json:"format"`
			Payload   string `json:"payload"`
			Signature string `json:"signature"`
		}{"nevix-release-v1", base64.StdEncoding.EncodeToString(payload), base64.StdEncoding.EncodeToString(ed25519.Sign(private, payload))})
		if _, err := release.Verify(envelope, public, "win32", "x64"); err == nil {
			t.Fatal("ambiguous artifact URL accepted")
		}
	}
}
