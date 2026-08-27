package creation

import (
	creationhttp "github.com/nevix-ai/server/internal/creation/interface/http"
)

// routes is the Module's static route table. Every V1 route is
// creator-private; no admin surface exists in this slice.
func (m *Module) routes() []creationhttp.Route {
	return []creationhttp.Route{
		{Method: "POST", Path: "/creation/sessions", Handler: m.sessions.CreateSession},
		{Method: "GET", Path: "/creation/sessions", Handler: m.sessions.ListSessions},
		{Method: "GET", Path: "/creation/sessions/{sessionID}", Handler: m.sessions.GetSession},
		{Method: "PATCH", Path: "/creation/sessions/{sessionID}", Handler: m.sessions.RenameSession},
		{Method: "DELETE", Path: "/creation/sessions/{sessionID}", Handler: m.sessions.DeleteSession},
		{Method: "GET", Path: "/creation/sessions/{sessionID}/materials", Handler: m.materials.ListMaterials},
		{Method: "POST", Path: "/creation/sessions/{sessionID}/materials", Handler: m.materials.UploadMaterial},
		{Method: "GET", Path: "/creation/materials/{materialID}", Handler: m.materials.DownloadMaterial},
		{Method: "DELETE", Path: "/creation/materials/{materialID}", Handler: m.materials.DeleteMaterial},
	}
}
