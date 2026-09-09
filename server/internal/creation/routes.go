package creation

import (
	creationhttp "github.com/nevix-ai/server/internal/creation/interface/http"
)

// routes is the Module's static route table. Session and material routes
// are creator-private (RequireActiveUser); the Provider Connection routes
// declare their admin guard here, and the member capability route stays
// active-user wide (spec #150 / ADR-0016).
func (m *Module) routes() []creationhttp.Route {
	return []creationhttp.Route{
		{Method: "POST", Path: "/creation/sessions", Handler: m.sessions.CreateSession},
		{Method: "GET", Path: "/creation/sessions", Handler: m.sessions.ListSessions},
		{Method: "GET", Path: "/creation/sessions/{sessionID}", Handler: m.sessions.GetSession},
		{Method: "PATCH", Path: "/creation/sessions/{sessionID}", Handler: m.sessions.RenameSession},
		{Method: "DELETE", Path: "/creation/sessions/{sessionID}", Handler: m.sessions.DeleteSession},
		{Method: "GET", Path: "/creation/sessions/{sessionID}/materials", Handler: m.materials.ListMaterials},
		{Method: "POST", Path: "/creation/sessions/{sessionID}/reference-material-uploads", Handler: m.materials.CreateReferenceMaterialUpload},
		{Method: "GET", Path: "/creation/reference-material-uploads/{uploadID}", Handler: m.materials.GetReferenceMaterialUpload},
		{Method: "POST", Path: "/creation/reference-material-uploads/{uploadID}", Handler: m.materials.FinalizeReferenceMaterialUpload},
		{Method: "POST", Path: "/creation/sessions/{sessionID}/materials/from-result", Handler: m.materials.CreateReferenceMaterialFromResult},
		{Method: "GET", Path: "/creation/materials/{materialID}", Handler: m.materials.DownloadMaterial},
		{Method: "DELETE", Path: "/creation/materials/{materialID}", Handler: m.materials.DeleteMaterial},
		{Method: "GET", Path: "/creation/provider-connection", Guard: creationhttp.GuardAdmin, Handler: m.connection.GetConnection},
		{Method: "POST", Path: "/creation/provider-connection", Guard: creationhttp.GuardAdmin, Handler: m.connection.Configure},
		{Method: "PUT", Path: "/creation/provider-connection/credential", Guard: creationhttp.GuardAdmin, Handler: m.connection.ReplaceCredential},
		{Method: "PATCH", Path: "/creation/provider-connection", Guard: creationhttp.GuardAdmin, Handler: m.connection.UpdateAdminState},
		{Method: "POST", Path: "/creation/provider-connection/recheck", Guard: creationhttp.GuardAdmin, Handler: m.connection.Recheck},
		{Method: "DELETE", Path: "/creation/provider-connection", Guard: creationhttp.GuardAdmin, Handler: m.connection.Delete},
		{Method: "GET", Path: "/creation/media-capabilities", Handler: m.connection.ListMediaCapabilities},
		{Method: "GET", Path: "/creation/object-storage-connection", Guard: creationhttp.GuardAdmin, Handler: m.objectStorage.Get},
		{Method: "POST", Path: "/creation/object-storage-connection", Guard: creationhttp.GuardAdmin, Handler: m.objectStorage.Create},
		{Method: "PUT", Path: "/creation/object-storage-connection", Guard: creationhttp.GuardAdmin, Handler: m.objectStorage.Replace},
		{Method: "DELETE", Path: "/creation/object-storage-connection", Guard: creationhttp.GuardAdmin, Handler: m.objectStorage.Delete},
		{Method: "POST", Path: "/creation/object-storage-connection/recheck", Guard: creationhttp.GuardAdmin, Handler: m.objectStorage.Recheck},
		{Method: "PUT", Path: "/creation/object-storage-connection/credential", Guard: creationhttp.GuardAdmin, Handler: m.objectStorage.Rotate},
		{Method: "POST", Path: "/creation/object-storage-connection/credential/recover", Guard: creationhttp.GuardAdmin, Handler: m.objectStorage.Recover},
		{Method: "GET", Path: "/creation/object-storage-capability", Handler: m.objectStorage.GetCapability},
		{Method: "GET", Path: "/creation/capability-manifest", Handler: m.manifest.GetManifest},
		// Generation task kernel (issue #159): creator-private task routes.
		{Method: "POST", Path: "/creation/sessions/{sessionID}/tasks", Handler: m.tasks.SubmitTask},
		{Method: "GET", Path: "/creation/sessions/{sessionID}/tasks", Handler: m.tasks.ListSessionTasks},
		{Method: "GET", Path: "/creation/tasks/{taskID}", Handler: m.tasks.GetTask},
		{Method: "POST", Path: "/creation/tasks/{taskID}/cancel", Handler: m.tasks.CancelTask},
		{Method: "POST", Path: "/creation/tasks/{taskID}/retry", Handler: m.tasks.RetryUncompleted},
		{Method: "GET", Path: "/creation/tasks/{taskID}/slots/{slotIndex}/result", Handler: m.tasks.DownloadSlotResult},
		// Creator-scoped SSE invalidation stream.
		{Method: "GET", Path: "/creation/events", Handler: m.hub.StreamEvents},
		// Admin generation governance and the persistent credit block.
		{Method: "GET", Path: "/creation/generation-governance", Guard: creationhttp.GuardAdmin, Handler: m.governance.GetGovernance},
		{Method: "PUT", Path: "/creation/generation-governance/instance", Guard: creationhttp.GuardAdmin, Handler: m.governance.PutInstanceGovernance},
		{Method: "PUT", Path: "/creation/generation-governance/users/{userID}", Guard: creationhttp.GuardAdmin, Handler: m.governance.PutUserGovernance},
		{Method: "DELETE", Path: "/creation/provider-connection/credit-block", Guard: creationhttp.GuardAdmin, Handler: m.governance.ClearCreditBlock},
	}
}
