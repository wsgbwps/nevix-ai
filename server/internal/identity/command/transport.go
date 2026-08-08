package command

import (
	"net"
	"net/http"
)

// ClientIP takes the peer address of the connection. V1 has no trusted reverse
// proxy in front of the Go server, so forwarding headers are attacker-controlled
// and deliberately not consulted.
func ClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
