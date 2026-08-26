// Deterministic evidence for the reauth package's pure decisions: the closed
// exact-action set, token entropy and hashing, the trusted-HTTPS marker rule,
// and the error mapping. Real-PostgreSQL behavior lives in
// reauth_integration_test.go.
package reauth

import (
	"crypto/sha256"
	"crypto/tls"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestValidActionAcceptsOnlyTheClosedExactActionSet(t *testing.T) {
	for _, action := range []string{
		ActionProviderConnectionCreate,
		ActionProviderConnectionReplace,
		ActionProviderConnectionDelete,
	} {
		if !ValidAction(action) {
			t.Fatalf("closed-set action %q rejected", action)
		}
	}
	// Nothing outside the three declared actions is pre-built: guesses,
	// prefixes, and look-alikes all fail closed.
	for _, action := range []string{
		"", "provider_connection", "provider_connection.delete-all",
		"provider_connection.CREATE", "user.delete", "connection.delete",
	} {
		if ValidAction(action) {
			t.Fatalf("action %q accepted outside the closed set", action)
		}
	}
}

func TestNewProofTokenIsOpaqueAndHashed(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 64; i++ {
		token, hash, err := NewProofToken()
		if err != nil {
			t.Fatalf("generate token: %v", err)
		}
		if len(token) != 43 { // 32 bytes, base64url without padding
			t.Fatalf("token %q has length %d, want 43 base64url characters", token, len(token))
		}
		if seen[token] {
			t.Fatalf("token repeated after %d draws; entropy is broken", i)
		}
		seen[token] = true
		want := sha256.Sum256([]byte(token))
		if string(hash) != string(want[:]) {
			t.Fatal("stored hash is not the SHA-256 of the token body")
		}
		if string(hash) == token {
			t.Fatal("hash equals the token body; the token would be stored verbatim")
		}
	}
}

func TestSecureTransportProvenAcceptsOnlyTrustedHTTPSProof(t *testing.T) {
	cases := []struct {
		name   string
		tls    bool
		header string
		want   bool
	}{
		{"direct TLS", true, "", true},
		{"proxy marker", false, "https", true},
		{"no proof", false, "", false},
		{"plaintext marker", false, "http", false},
		{"list-valued spoof", false, "https, http", false},
		{"case-altered spoof", false, "HTTPS", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/identity/admin/reauth/proofs", nil)
			if tc.tls {
				// httptest.NewRequest never populates TLS; the field is the
				// direct-connection proof, set directly.
				req.TLS = &tls.ConnectionState{}
			}
			if tc.header != "" {
				req.Header.Set("X-Forwarded-Proto", tc.header)
			}
			if got := SecureTransportProven(req); got != tc.want {
				t.Fatalf("SecureTransportProven = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMapErrorCarriesTheStableMachineCodes(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{ErrInsecureTransport, http.StatusBadRequest, "secure_transport_required"},
		{ErrProofInvalid, http.StatusBadRequest, "reauth_proof_invalid"},
		{ErrProofActionMismatch, http.StatusConflict, "reauth_proof_action_mismatch"},
		{ErrProofAlreadyConsumed, http.StatusConflict, "reauth_proof_already_consumed"},
		{ErrProofExpired, http.StatusGone, "reauth_proof_expired"},
	}
	for _, tc := range cases {
		mapped := MapError(tc.err)
		if mapped == nil {
			t.Fatalf("%v unmapped", tc.err)
		}
		if mapped.Status != tc.status || mapped.Code != tc.code {
			t.Fatalf("%v mapped to %d %s, want %d %s", tc.err, mapped.Status, mapped.Code, tc.status, tc.code)
		}
	}
	if mapped := MapError(errors.New("unknown")); mapped != nil {
		t.Fatalf("unknown error mapped to %d %s; it must fall through to the 500 path", mapped.Status, mapped.Code)
	}
}
