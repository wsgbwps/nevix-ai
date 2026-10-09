package creationhttp

import (
	"net/http"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/application"
	"github.com/nevix-ai/server/internal/creation/domain"
)

// MaintenanceHandler exposes the Admin-authorized maintenance seam over proven HTTPS.
type MaintenanceHandler struct {
	service *application.MaintenanceService
}

func NewMaintenanceHandler(service *application.MaintenanceService) *MaintenanceHandler {
	return &MaintenanceHandler{service: service}
}

type maintenanceResource struct {
	Paused           bool    `json:"paused"`
	OwnerToken       *string `json:"owner_token"`
	Revision         int64   `json:"revision"`
	NonTerminalTasks int64   `json:"non_terminal_tasks"`
	Drained          bool    `json:"drained"`
}

func writeMaintenance(w http.ResponseWriter, state domain.Maintenance) {
	var owner *string
	if state.OwnerToken != nil {
		value := state.OwnerToken.String()
		owner = &value
	}
	encodeJSON(w, http.StatusOK, maintenanceResource{state.Paused, owner, state.Revision, state.NonTerminalTasks, state.Paused && state.NonTerminalTasks == 0})
}

func (h *MaintenanceHandler) Get(w http.ResponseWriter, r *http.Request) {
	if !requireSecureTransport(w, r) {
		return
	}
	state, err := h.service.Snapshot(r.Context())
	if err != nil {
		fail(w, r, err)
		return
	}
	writeMaintenance(w, state)
}

func (h *MaintenanceHandler) Pause(w http.ResponseWriter, r *http.Request)  { h.change(w, r, true) }
func (h *MaintenanceHandler) Resume(w http.ResponseWriter, r *http.Request) { h.change(w, r, false) }

func (h *MaintenanceHandler) change(w http.ResponseWriter, r *http.Request, paused bool) {
	if !requireSecureTransport(w, r) {
		return
	}
	var input struct {
		OwnerToken       string `json:"owner_token"`
		ExpectedRevision *int64 `json:"expected_revision"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	owner, err := domain.ParseUUID(input.OwnerToken)
	if err != nil || owner == (domain.UUID{}) || input.ExpectedRevision == nil || *input.ExpectedRevision < 0 {
		WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "A nonzero owner_token UUID and nonnegative expected_revision are required."})
		return
	}
	principal, _ := authz.PrincipalFrom(r.Context())
	state, err := h.service.Change(r.Context(), principal, paused, owner, *input.ExpectedRevision)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeMaintenance(w, state)
}
