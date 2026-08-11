// The Module's trusted-command route table. Public is zero-value safe: a
// route that does not declare Public: true is mounted behind the Bearer
// guard, and every path's OPTIONS preflight twin and Allow-Methods value
// derive from this single table (see command.Mount and command.AllowMethods).
package identity

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/invitations"
	"github.com/nevix-ai/server/internal/identity/organizations"
	"github.com/nevix-ai/server/internal/identity/verification"
)

func (m *Module) routes() []command.Route {
	return []command.Route{
		{
			Method: http.MethodPost,
			Path:   "/identity/verification-codes",
			Public: true,
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, req verification.IssueVerificationCodeRequest) (verification.IssueVerificationCodeResponse, error) {
				req.ClientIP = command.ClientIP(r)
				return m.issuer.IssueVerificationCode(ctx, req)
			}, verification.MapError, http.StatusAccepted),
		},
		{
			Method:  http.MethodPost,
			Path:    "/identity/organizations",
			Handler: command.Handle(m.orgs.CreateOrganization, organizations.MapError, http.StatusOK),
		},
		{
			Method: http.MethodPost,
			Path:   "/identity/organizations/{organizationID}/invitations",
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, req invitations.CreateInvitationRequest) (invitations.InvitationResponse, error) {
				req.OrganizationID = chi.URLParam(r, "organizationID")
				req.ClientIP = command.ClientIP(r)
				return m.invitations.CreateInvitation(ctx, req)
			}, invitations.MapError, http.StatusAccepted),
		},
		{
			Method: http.MethodPost,
			Path:   "/identity/organizations/{organizationID}/invitations/{invitationID}/resend",
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, req invitations.ResendInvitationRequest) (invitations.InvitationResponse, error) {
				req.OrganizationID = chi.URLParam(r, "organizationID")
				req.InvitationID = chi.URLParam(r, "invitationID")
				req.ClientIP = command.ClientIP(r)
				return m.invitations.ResendInvitation(ctx, req)
			}, invitations.MapError, http.StatusAccepted),
		},
		{
			Method: http.MethodPost,
			Path:   "/identity/organizations/{organizationID}/invitations/{invitationID}/revoke",
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, req invitations.RevokeInvitationRequest) (invitations.InvitationResponse, error) {
				req.OrganizationID = chi.URLParam(r, "organizationID")
				req.InvitationID = chi.URLParam(r, "invitationID")
				return m.invitations.RevokeInvitation(ctx, req)
			}, invitations.MapError, http.StatusOK),
		},
		{
			Method: http.MethodPost,
			Path:   "/identity/invitations/{invitationID}/accept",
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, req invitations.AcceptInvitationRequest) (invitations.AcceptInvitationResponse, error) {
				req.InvitationID = chi.URLParam(r, "invitationID")
				return m.invitations.AcceptInvitation(ctx, req)
			}, invitations.MapError, http.StatusOK),
		},
	}
}
