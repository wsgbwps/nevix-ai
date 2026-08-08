// The Module's trusted-command route table. Public is zero-value safe: a
// route that does not declare Public: true is mounted behind the Bearer
// guard, and every path's OPTIONS preflight twin and Allow-Methods value
// derive from this single table (see command.Mount and command.AllowMethods).
package identity

import (
	"context"
	"net/http"

	"github.com/nevix-ai/server/internal/identity/command"
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
	}
}
