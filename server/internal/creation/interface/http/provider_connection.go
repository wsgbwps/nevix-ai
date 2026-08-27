package creationhttp

import (
	"net/http"
	"time"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/application"
	"github.com/nevix-ai/server/internal/creation/domain"
)

// ProviderConnectionHandler adapts the AI Provider Connection commands and
// views onto the wire contract. Admin routes are guarded by the route
// table; every key-bearing command additionally requires proven HTTPS
// transport before its proof is consumed, and no response ever carries key
// material, endpoints, model ids, or provider diagnostics.
type ProviderConnectionHandler struct {
	service *application.ConnectionService
}

func NewProviderConnectionHandler(service *application.ConnectionService) *ProviderConnectionHandler {
	return &ProviderConnectionHandler{service: service}
}

// providerConnectionView is the sanitized admin projection of the
// connection aggregate (contracts/creation.yaml ProviderConnection).
type providerConnectionView struct {
	ID               string     `json:"id"`
	AdminState       string     `json:"admin_state"`
	CredentialState  string     `json:"credential_state"`
	ImageCapability  string     `json:"image_capability"`
	VideoCapability  string     `json:"video_capability"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
	LastCheckedAt    *time.Time `json:"last_checked_at"`
	LastCheckOutcome *string    `json:"last_check_outcome"`
	NeedsAttention   bool       `json:"needs_attention"`
}

func connectionView(c domain.ProviderConnection) providerConnectionView {
	view := providerConnectionView{
		ID:              c.ID.String(),
		AdminState:      string(c.AdminState),
		CredentialState: string(c.CredentialState),
		ImageCapability: string(c.ImageCapability),
		VideoCapability: string(c.VideoCapability),
		CreatedAt:       c.CreatedAt,
		UpdatedAt:       c.UpdatedAt,
		LastCheckedAt:   c.LastCheckedAt,
		NeedsAttention:  c.NeedsAttention(),
	}
	if c.LastCheckOutcome != nil {
		view.LastCheckOutcome = new(string)
		*view.LastCheckOutcome = string(*c.LastCheckOutcome)
	}
	return view
}

// credentialInput is the shared body of the two key-bearing commands.
type credentialInput struct {
	Proof       *string `json:"proof"`
	ProviderKey *string `json:"provider_key"`
}

// GetConnection answers the admin governance view.
func (h *ProviderConnectionHandler) GetConnection(w http.ResponseWriter, r *http.Request) {
	connection, err := h.service.GetActive(r.Context())
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, connectionView(connection))
}

// Configure establishes the first connection behind an exact-action proof.
func (h *ProviderConnectionHandler) Configure(w http.ResponseWriter, r *http.Request) {
	if !requireSecureTransport(w, r) {
		return
	}
	principal, ok := authz.PrincipalFrom(r.Context())
	if !ok {
		WriteError(w, &Error{Status: http.StatusUnauthorized, Code: CodeUnauthorized, Message: "Authentication required."})
		return
	}
	var input credentialInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Proof == nil || input.ProviderKey == nil || *input.ProviderKey == "" || len(*input.ProviderKey) > 4096 {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "Request body must be JSON with proof and provider_key."})
		return
	}
	connection, err := h.service.Configure(r.Context(), principal, *input.Proof, *input.ProviderKey)
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusCreated, connectionView(connection))
}

// ReplaceCredential switches the Provider Key through a validated candidate.
func (h *ProviderConnectionHandler) ReplaceCredential(w http.ResponseWriter, r *http.Request) {
	if !requireSecureTransport(w, r) {
		return
	}
	principal, ok := authz.PrincipalFrom(r.Context())
	if !ok {
		WriteError(w, &Error{Status: http.StatusUnauthorized, Code: CodeUnauthorized, Message: "Authentication required."})
		return
	}
	var input credentialInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Proof == nil || input.ProviderKey == nil || *input.ProviderKey == "" || len(*input.ProviderKey) > 4096 {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "Request body must be JSON with proof and provider_key."})
		return
	}
	connection, err := h.service.Replace(r.Context(), principal, *input.Proof, *input.ProviderKey)
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, connectionView(connection))
}

// UpdateAdminState pauses or resumes the connection.
func (h *ProviderConnectionHandler) UpdateAdminState(w http.ResponseWriter, r *http.Request) {
	principal, ok := authz.PrincipalFrom(r.Context())
	if !ok {
		WriteError(w, &Error{Status: http.StatusUnauthorized, Code: CodeUnauthorized, Message: "Authentication required."})
		return
	}
	var input struct {
		AdminState *string `json:"admin_state"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.AdminState == nil || !domain.ValidAdminState(*input.AdminState) {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "Request body must be JSON with admin_state of enabled or paused."})
		return
	}
	connection, err := h.service.SetAdminState(r.Context(), principal, domain.AdminState(*input.AdminState))
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, connectionView(connection))
}

// Recheck repeats the connection check for the stored credential.
func (h *ProviderConnectionHandler) Recheck(w http.ResponseWriter, r *http.Request) {
	principal, ok := authz.PrincipalFrom(r.Context())
	if !ok {
		WriteError(w, &Error{Status: http.StatusUnauthorized, Code: CodeUnauthorized, Message: "Authentication required."})
		return
	}
	connection, err := h.service.Recheck(r.Context(), principal)
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, connectionView(connection))
}

// Delete terminates the connection behind an exact-action proof.
func (h *ProviderConnectionHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if !requireSecureTransport(w, r) {
		return
	}
	principal, ok := authz.PrincipalFrom(r.Context())
	if !ok {
		WriteError(w, &Error{Status: http.StatusUnauthorized, Code: CodeUnauthorized, Message: "Authentication required."})
		return
	}
	var input struct {
		Proof *string `json:"proof"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Proof == nil {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "Request body must be JSON with proof."})
		return
	}
	connection, err := h.service.Delete(r.Context(), principal, *input.Proof)
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, connectionView(connection))
}

// mediaCapabilityStatusView is one media's member projection; reason and
// action are null exactly when the media is available.
type mediaCapabilityStatusView struct {
	Status string  `json:"status"`
	Reason *string `json:"reason"`
	Action *string `json:"action"`
}

type mediaCapabilitiesView struct {
	Image mediaCapabilityStatusView `json:"image"`
	Video mediaCapabilityStatusView `json:"video"`
}

func capabilityStatusView(view domain.MediaCapabilityView) mediaCapabilityStatusView {
	status := mediaCapabilityStatusView{Status: string(view.Status)}
	if view.Reason != "" {
		status.Reason = &view.Reason
	}
	if view.Action != "" {
		status.Action = &view.Action
	}
	return status
}

// ListMediaCapabilities answers the member surface: per-media status,
// stable reason, and stable action advice only.
func (h *ProviderConnectionHandler) ListMediaCapabilities(w http.ResponseWriter, r *http.Request) {
	view, err := h.service.MemberCapabilities(r.Context())
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, mediaCapabilitiesView{
		Image: capabilityStatusView(view.Image),
		Video: capabilityStatusView(view.Video),
	})
}
