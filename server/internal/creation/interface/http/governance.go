package creationhttp

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/nevix-ai/server/internal/auditlog"
	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/application"
	"github.com/nevix-ai/server/internal/creation/domain"
)

// GovernanceHandler owns the admin generation-governance routes and the
// persistent provider-credit-block clear command.
type GovernanceHandler struct {
	governance  *application.GovernanceService
	connections *application.ConnectionService
}

func NewGovernanceHandler(governance *application.GovernanceService, connections *application.ConnectionService) *GovernanceHandler {
	return &GovernanceHandler{governance: governance, connections: connections}
}

type governanceLimitsResource struct {
	ImageConcurrency *int `json:"image_concurrency"`
	VideoConcurrency *int `json:"video_concurrency"`
	RateLimit        *int `json:"rate_limit"`
	MonthlyTaskLimit *int `json:"monthly_task_limit"`
}

func toLimitsResource(policy domain.GovernancePolicy) governanceLimitsResource {
	return governanceLimitsResource{
		ImageConcurrency: policy.ImageConcurrency,
		VideoConcurrency: policy.VideoConcurrency,
		RateLimit:        policy.RateLimit,
		MonthlyTaskLimit: policy.MonthlyTaskLimit,
	}
}

type governanceViewResource struct {
	Instance *governanceLimitsResource `json:"instance"`
	Users    []governanceUserResource  `json:"users"`
}

type governanceUserResource struct {
	UserID string                   `json:"user_id"`
	Limits governanceLimitsResource `json:"limits"`
}

// GetGovernance answers GET /creation/generation-governance.
func (h *GovernanceHandler) GetGovernance(w http.ResponseWriter, r *http.Request) {
	view, err := h.governance.View(r.Context())
	if err != nil {
		fail(w, r, err)
		return
	}
	resource := governanceViewResource{Users: []governanceUserResource{}}
	if view.Instance != nil {
		instance := toLimitsResource(*view.Instance)
		resource.Instance = &instance
	}
	for _, entry := range view.Users {
		resource.Users = append(resource.Users, governanceUserResource{
			UserID: entry.UserID.String(),
			Limits: toLimitsResource(entry.Policy),
		})
	}
	encodeJSON(w, http.StatusOK, resource)
}

type putLimitsRequest struct {
	ImageConcurrency *int `json:"image_concurrency"`
	VideoConcurrency *int `json:"video_concurrency"`
	RateLimit        *int `json:"rate_limit"`
	MonthlyTaskLimit *int `json:"monthly_task_limit"`
}

func (h *GovernanceHandler) decodeLimits(w http.ResponseWriter, r *http.Request) (*putLimitsRequest, bool) {
	var req putLimitsRequest
	if !decodeJSON(w, r, &req) {
		return nil, false
	}
	for _, limit := range []*int{req.ImageConcurrency, req.VideoConcurrency, req.RateLimit, req.MonthlyTaskLimit} {
		if limit != nil && *limit < 0 {
			WriteError(w, &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: "Governance limits must be zero or positive."})
			return nil, false
		}
	}
	return &req, true
}

// PutInstanceGovernance answers PUT /creation/generation-governance/instance.
func (h *GovernanceHandler) PutInstanceGovernance(w http.ResponseWriter, r *http.Request) {
	req, ok := h.decodeLimits(w, r)
	if !ok {
		return
	}
	policy, err := h.governance.PutInstance(r.Context(), principal(w, r), domain.GovernancePolicy{
		Scope:            domain.GovernanceScopeInstance,
		ImageConcurrency: req.ImageConcurrency,
		VideoConcurrency: req.VideoConcurrency,
		RateLimit:        req.RateLimit,
		MonthlyTaskLimit: req.MonthlyTaskLimit,
	})
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, toLimitsResource(policy))
}

// PutUserGovernance answers PUT /creation/generation-governance/users/{userID}.
func (h *GovernanceHandler) PutUserGovernance(w http.ResponseWriter, r *http.Request) {
	userID, ok := pathUUID(w, r, "userID")
	if !ok {
		return
	}
	req, ok := h.decodeLimits(w, r)
	if !ok {
		return
	}
	policy, err := h.governance.PutUser(r.Context(), principal(w, r), userID, domain.GovernancePolicy{
		Scope:            domain.GovernanceScopeUser,
		UserID:           &userID,
		ImageConcurrency: req.ImageConcurrency,
		VideoConcurrency: req.VideoConcurrency,
		RateLimit:        req.RateLimit,
		MonthlyTaskLimit: req.MonthlyTaskLimit,
	})
	if err != nil {
		fail(w, r, err)
		return
	}
	encodeJSON(w, http.StatusOK, toLimitsResource(policy))
}

// ClearCreditBlock answers DELETE /creation/provider-connection/credit-block.
func (h *GovernanceHandler) ClearCreditBlock(w http.ResponseWriter, r *http.Request) {
	if err := h.connections.ClearCreditBlock(r.Context(), principal(w, r)); err != nil {
		fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// principal mirrors creatorID for admin-scoped commands.
func principal(w http.ResponseWriter, r *http.Request) authz.Principal {
	p, _ := authz.PrincipalFrom(r.Context())
	return p
}

var _ = auditlog.Append
var _ = chi.URLParam
