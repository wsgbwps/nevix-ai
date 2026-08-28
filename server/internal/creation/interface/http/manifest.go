package creationhttp

import (
	"net/http"

	"github.com/nevix-ai/server/internal/creation/application"
)

// CapabilityManifestHandler serves the versioned Capability Manifest read
// contract. It is a pure projection: no command, no audit row, and the same
// payload for admins and members — capability values are product surface,
// while endpoint, credential, and diagnostics never appear here.
type CapabilityManifestHandler struct {
	service *application.ManifestService
}

func NewCapabilityManifestHandler(service *application.ManifestService) *CapabilityManifestHandler {
	return &CapabilityManifestHandler{service: service}
}

// GetManifest answers GET /creation/capability-manifest.
func (h *CapabilityManifestHandler) GetManifest(w http.ResponseWriter, r *http.Request) {
	manifest, err := h.service.CapabilityManifest(r.Context())
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, manifest)
}
