package creationhttp

import (
	"net/http"
	"strings"
	"time"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/application"
	"github.com/nevix-ai/server/internal/creation/domain"
)

type ObjectStorageConnectionHandler struct {
	service *application.ObjectStorageConnectionService
}

func NewObjectStorageConnectionHandler(service *application.ObjectStorageConnectionService) *ObjectStorageConnectionHandler {
	return &ObjectStorageConnectionHandler{service: service}
}

type objectStorageCredentialView struct {
	AccessKeyIDMasked         string `json:"access_key_id_masked"`
	SecretAccessKeyConfigured bool   `json:"secret_access_key_configured"`
}

type objectStorageObservationView struct {
	CheckedAt time.Time `json:"checked_at"`
	Outcome   string    `json:"outcome"`
}

type objectStorageConnectionView struct {
	State       string                        `json:"state"`
	Provider    string                        `json:"provider,omitempty"`
	Region      string                        `json:"region,omitempty"`
	Bucket      string                        `json:"bucket,omitempty"`
	Revision    *int64                        `json:"revision,omitempty"`
	Credential  *objectStorageCredentialView  `json:"credential,omitempty"`
	Observation *objectStorageObservationView `json:"observation,omitempty"`
}

func objectStorageAdminView(connection domain.ObjectStorageConnection) objectStorageConnectionView {
	view := objectStorageConnectionView{State: string(connection.State)}
	if connection.State == domain.ObjectStorageStateUnconfigured {
		return view
	}
	view.Provider = string(connection.Provider)
	view.Region = connection.Region
	view.Bucket = connection.Bucket
	view.Revision = &connection.Revision
	view.Credential = &objectStorageCredentialView{
		AccessKeyIDMasked: connection.AccessKeyIDMasked, SecretAccessKeyConfigured: true,
	}
	view.Observation = &objectStorageObservationView{
		CheckedAt: connection.LastCheckedAt, Outcome: string(connection.LastCheckOutcome),
	}
	return view
}

func (h *ObjectStorageConnectionHandler) Get(w http.ResponseWriter, r *http.Request) {
	connection, err := h.service.GetAdmin(r.Context())
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, objectStorageAdminView(connection))
}

type objectStorageConnectionInput struct {
	Proof           *string `json:"proof"`
	Provider        *string `json:"provider"`
	Region          *string `json:"region"`
	Bucket          *string `json:"bucket"`
	AccessKeyID     *string `json:"access_key_id"`
	SecretAccessKey *string `json:"secret_access_key"`
}

func (h *ObjectStorageConnectionHandler) Create(w http.ResponseWriter, r *http.Request) {
	if !requireSecureTransport(w, r) {
		return
	}
	principal, ok := authz.PrincipalFrom(r.Context())
	if !ok {
		WriteError(w, &Error{Status: http.StatusUnauthorized, Code: CodeUnauthorized, Message: "Authentication required."})
		return
	}
	var input objectStorageConnectionInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if !validObjectStorageInput(input) {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "Request body must include proof, provider, region, bucket, access_key_id, and secret_access_key."})
		return
	}
	connection, err := h.service.Create(r.Context(), principal, *input.Proof, domain.ObjectStorageCandidate{
		Location: domain.ObjectStorageLocation{
			Provider: domain.ObjectStorageProvider(*input.Provider), Region: *input.Region, Bucket: *input.Bucket,
		},
		Credentials: domain.ObjectStorageCredentials{AccessKeyID: *input.AccessKeyID, SecretAccessKey: *input.SecretAccessKey},
	})
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusCreated, objectStorageAdminView(connection))
}

func validObjectStorageInput(input objectStorageConnectionInput) bool {
	if input.Proof == nil || input.Provider == nil || input.Region == nil || input.Bucket == nil || input.AccessKeyID == nil || input.SecretAccessKey == nil {
		return false
	}
	for _, value := range []*string{input.Provider, input.Region, input.Bucket, input.AccessKeyID, input.SecretAccessKey} {
		if strings.TrimSpace(*value) == "" || len(*value) > 1024 {
			return false
		}
	}
	return true
}

type objectStorageCapabilityView struct {
	Available          bool   `json:"available"`
	Provider           string `json:"provider,omitempty"`
	UploadOrigin       string `json:"upload_origin,omitempty"`
	ConnectionRevision *int64 `json:"connection_revision,omitempty"`
}

func (h *ObjectStorageConnectionHandler) GetCapability(w http.ResponseWriter, r *http.Request) {
	capability, err := h.service.Capability(r.Context())
	if err != nil {
		fail(w, r, err)
		return
	}
	view := objectStorageCapabilityView{Available: capability.Available}
	if capability.Provider != "" {
		view.Provider = string(capability.Provider)
		view.ConnectionRevision = &capability.ConnectionRevision
	}
	if capability.Available {
		view.UploadOrigin = capability.UploadOrigin
	}
	encodeJSON(w, http.StatusOK, view)
}
