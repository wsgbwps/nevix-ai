package authz

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"testing"
)

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
			req := httptest.NewRequest(http.MethodPost, "/proof-bearing", nil)
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
