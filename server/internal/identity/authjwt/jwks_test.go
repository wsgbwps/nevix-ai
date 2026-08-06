// Unit tests for the Module-private Bearer JWT verification: ES256/P-256
// signatures against a JWKS endpoint, kid-keyed caching with a refresh on
// unknown kid, and the middleware's uniform 401 envelope. No stack required.
package authjwt_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nevix-ai/server/internal/identity/authjwt"
)

// testJWKS serves an ES256 key set whose contents can change between
// requests, counting fetches so tests can observe the cache.
type testJWKS struct {
	mu      sync.Mutex
	keys    map[string]*ecdsa.PublicKey
	fetches atomic.Int64
	server  *httptest.Server
}

func newTestJWKS(t *testing.T) *testJWKS {
	t.Helper()
	j := &testJWKS{keys: map[string]*ecdsa.PublicKey{}}
	j.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		j.fetches.Add(1)
		j.mu.Lock()
		defer j.mu.Unlock()
		type jwk struct {
			Kty string `json:"kty"`
			Crv string `json:"crv"`
			Use string `json:"use"`
			Kid string `json:"kid"`
			X   string `json:"x"`
			Y   string `json:"y"`
		}
		out := make([]jwk, 0, len(j.keys))
		for kid, key := range j.keys {
			out = append(out, jwk{
				Kty: "EC", Crv: "P-256", Use: "sig", Kid: kid,
				X: base64.RawURLEncoding.EncodeToString(key.X.Bytes()),
				Y: base64.RawURLEncoding.EncodeToString(key.Y.Bytes()),
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": out})
	}))
	t.Cleanup(j.server.Close)
	return j
}

func (j *testJWKS) addKey(kid string, key *ecdsa.PublicKey) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.keys[kid] = key
}

// signES256 mints a JWT the way a session issuer would: ES256 header with
// kid, JSON claims, raw R||S signature.
func signES256(t *testing.T, key *ecdsa.PrivateKey, kid, sub string, exp time.Time) string {
	t.Helper()
	header, err := json.Marshal(map[string]string{"alg": "ES256", "typ": "JWT", "kid": kid})
	if err != nil {
		t.Fatalf("marshal header: %v", err)
	}
	claims := map[string]any{"exp": exp.Unix()}
	if sub != "" {
		claims["sub"] = sub
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	signingInput := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	r, s, err := ecdsa.Sign(rand.Reader, key, []byte(signingInput))
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func newTestKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate ES256 key: %v", err)
	}
	return key
}

func TestVerifyTokenAcceptsValidES256Session(t *testing.T) {
	jwks := newTestJWKS(t)
	key := newTestKey(t)
	jwks.addKey("key-1", &key.PublicKey)
	verifier := authjwt.NewVerifier(jwks.server.URL)

	userID, err := verifier.VerifyToken(context.Background(),
		signES256(t, key, "key-1", "11111111-2222-3333-4444-555555555555", time.Now().Add(time.Hour)))
	if err != nil {
		t.Fatalf("verify valid token: %v", err)
	}
	if userID != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("verified subject %q, want the token's sub", userID)
	}
}

func TestVerifyTokenRejectsInvalidTokens(t *testing.T) {
	jwks := newTestJWKS(t)
	key := newTestKey(t)
	otherKey := newTestKey(t)
	jwks.addKey("key-1", &key.PublicKey)
	verifier := authjwt.NewVerifier(jwks.server.URL)
	valid := signES256(t, key, "key-1", "subject-1", time.Now().Add(time.Hour))

	tampered := valid[:len(valid)-2] + "zz"
	cases := []struct {
		name  string
		token string
	}{
		{"empty", ""},
		{"not a jwt", "nonsense"},
		{"expired", signES256(t, key, "key-1", "subject-1", time.Now().Add(-time.Minute))},
		{"missing subject", signES256(t, key, "key-1", "", time.Now().Add(time.Hour))},
		{"signed by unknown key", signES256(t, otherKey, "key-1", "subject-1", time.Now().Add(time.Hour))},
		{"tampered signature", tampered},
	}
	for _, tc := range cases {
		if _, err := verifier.VerifyToken(context.Background(), tc.token); err == nil {
			t.Fatalf("%s token verified, want rejection", tc.name)
		}
	}

	// A non-ES256 header is rejected even if the rest looks plausible.
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT","kid":"key-1"}`))
	if _, err := verifier.VerifyToken(context.Background(), header+".e30.c2ln"); err == nil {
		t.Fatal("HS256 token verified, want rejection")
	}
}

func TestVerifyTokenRefreshesOnUnknownKid(t *testing.T) {
	jwks := newTestJWKS(t)
	verifier := authjwt.NewVerifier(jwks.server.URL)

	// The key is not published yet: the first verification fetches and fails.
	key := newTestKey(t)
	token := signES256(t, key, "rotated-1", "subject-1", time.Now().Add(time.Hour))
	if _, err := verifier.VerifyToken(context.Background(), token); err == nil {
		t.Fatal("token verified before its kid was published")
	}

	// After rotation publishes the kid, verification must refresh and pass.
	jwks.addKey("rotated-1", &key.PublicKey)
	if _, err := verifier.VerifyToken(context.Background(), token); err != nil {
		t.Fatalf("token rejected after kid rotation was published: %v", err)
	}
}

func TestVerifyTokenCachesKeysByKid(t *testing.T) {
	jwks := newTestJWKS(t)
	key := newTestKey(t)
	jwks.addKey("key-1", &key.PublicKey)
	verifier := authjwt.NewVerifier(jwks.server.URL)
	token := signES256(t, key, "key-1", "subject-1", time.Now().Add(time.Hour))

	for i := 0; i < 5; i++ {
		if _, err := verifier.VerifyToken(context.Background(), token); err != nil {
			t.Fatalf("verification %d failed: %v", i+1, err)
		}
	}
	if fetches := jwks.fetches.Load(); fetches != 1 {
		t.Fatalf("JWKS fetched %d times for five cached verifications, want 1", fetches)
	}
}

func TestMiddlewareRejectsMissingAndInvalidBearers(t *testing.T) {
	jwks := newTestJWKS(t)
	key := newTestKey(t)
	jwks.addKey("key-1", &key.PublicKey)
	verifier := authjwt.NewVerifier(jwks.server.URL)

	var seenUser string
	protected := verifier.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenUser = authjwt.UserID(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	do := func(authorization string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/identity/organizations", nil)
		if authorization != "" {
			req.Header.Set("Authorization", authorization)
		}
		rec := httptest.NewRecorder()
		protected.ServeHTTP(rec, req)
		return rec
	}

	for _, authorization := range []string{"", "Bearer", "Bearer garbage",
		"Bearer " + signES256(t, key, "key-1", "subject-1", time.Now().Add(-time.Minute))} {
		rec := do(authorization)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("Authorization %q: status %d, want 401", authorization, rec.Code)
		}
		var envelope struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("Authorization %q: 401 body is not JSON: %v", authorization, err)
		}
		if envelope.Error != "unauthorized" || envelope.Message == "" {
			t.Fatalf("Authorization %q: envelope %+v, want error=unauthorized with message", authorization, envelope)
		}
	}

	rec := do("Bearer " + signES256(t, key, "key-1", "subject-9", time.Now().Add(time.Hour)))
	if rec.Code != http.StatusOK || seenUser != "subject-9" {
		t.Fatalf("valid bearer: status %d user %q, want 200 and the token's subject", rec.Code, seenUser)
	}
}
