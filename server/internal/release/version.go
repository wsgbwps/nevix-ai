// Package release owns publisher trust and public running release identity.
package release

import (
	"encoding/json"
	"net/http"
)

// Build identity is set by the release build, never customer environment.
var Version = "development"
var MinDesktopVersion = "0.1.0"

// PublicKeyPEM pins the vendor Ed25519 release identity, shared by Desktop and operator tools.
const PublicKeyPEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEABVTDGM49ggkKRezISrltAil5Tgl7VqPnOG+Qe5hFdAg=
-----END PUBLIC KEY-----`

func (m *Module) writeVersion(w http.ResponseWriter, _ *http.Request) {
	status := m.snapshot()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(struct {
		Service           string `json:"service"`
		Version           string `json:"version"`
		MinDesktopVersion string `json:"min_desktop_version"`
	}{"nevix-server", status.Version, status.MinDesktopVersion})
}

func validateBuildIdentity() error {
	if Version != "development" {
		if _, err := CompareVersions(Version, "0.0.0"); err != nil {
			return err
		}
	}
	_, err := CompareVersions(MinDesktopVersion, "0.0.0")
	return err
}
