package command_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nevix-ai/server/internal/identity/command"
)

func TestClientIPUsesConnectionPeer(t *testing.T) {
	for _, tc := range []struct {
		name       string
		remoteAddr string
		forwarded  string
		want       string
	}{
		{
			name:       "host port ignores forwarded header",
			remoteAddr: "10.0.0.8:43210",
			forwarded:  "203.0.113.9",
			want:       "10.0.0.8",
		},
		{
			name:       "unparseable peer address is preserved",
			remoteAddr: "pipe",
			want:       "pipe",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/identity/verification-codes", nil)
			req.RemoteAddr = tc.remoteAddr
			req.Header.Set("X-Forwarded-For", tc.forwarded)

			if got := command.ClientIP(req); got != tc.want {
				t.Fatalf("ClientIP(%q) = %q, want %q", tc.remoteAddr, got, tc.want)
			}
		})
	}
}
