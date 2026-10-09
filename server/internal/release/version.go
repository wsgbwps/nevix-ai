// Package release owns publisher trust and public running release identity.
package release

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Build identity is set by the release build, never customer environment.
var Version = "development"
var MinDesktopVersion = "0.1.0"

// PublicKeyPEM is provisioned and reviewed before formal release; empty fails closed.
const PublicKeyPEM = ""

func RegisterVersion(r chi.Router) {
	r.Get("/release/version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(struct {
			Service           string `json:"service"`
			Version           string `json:"version"`
			MinDesktopVersion string `json:"min_desktop_version"`
		}{"nevix-server", Version, MinDesktopVersion})
	})
}

func ValidateBuildIdentity() error {
	if Version != "development" {
		if _, err := CompareVersions(Version, "0.0.0"); err != nil {
			return err
		}
	}
	_, err := CompareVersions(MinDesktopVersion, "0.0.0")
	return err
}
