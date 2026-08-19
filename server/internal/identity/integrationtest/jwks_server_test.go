// Test key set for the Bearer JWT transport: publishes one ES256 key as a
// JWKS document over httptest and signs session JWTs with it — the test
// stand-in for the auth provider's key set, so verification runs on the same
// seam production uses.
package integrationtest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// es256KeyServer publishes one ES256 key as a JWKS document and signs session
// JWTs with it.
type es256KeyServer struct {
	key    *ecdsa.PrivateKey
	kid    string
	server *httptest.Server
}

func newES256KeyServer(t *testing.T) *es256KeyServer {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate ES256 test key: %v", err)
	}
	ks := &es256KeyServer{key: key, kid: "transport-test-key"}
	ks.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "EC", "crv": "P-256", "use": "sig", "kid": ks.kid,
			"x": base64.RawURLEncoding.EncodeToString(key.X.Bytes()),
			"y": base64.RawURLEncoding.EncodeToString(key.Y.Bytes()),
		}}})
	}))
	t.Cleanup(ks.server.Close)
	return ks
}

// signToken mints an ES256 session JWT for the given user id.
func (ks *es256KeyServer) signToken(t *testing.T, sub string, exp time.Time) string {
	t.Helper()
	header, err := json.Marshal(map[string]string{"alg": "ES256", "typ": "JWT", "kid": ks.kid})
	if err != nil {
		t.Fatalf("marshal jwt header: %v", err)
	}
	payload, err := json.Marshal(map[string]any{"sub": sub, "exp": exp.Unix()})
	if err != nil {
		t.Fatalf("marshal jwt claims: %v", err)
	}
	signingInput := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	// ES256 signs the SHA-256 digest of the signing input, matching GoTrue's
	// issuance and the verifier in authjwt; ecdsa.Sign does not hash itself.
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, ks.key, digest[:])
	if err != nil {
		t.Fatalf("sign jwt: %v", err)
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
}
