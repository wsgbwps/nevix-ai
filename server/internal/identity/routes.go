// The Module's trusted-command route table. The zero-value guard is
// RequireActiveUser: only the login command declares GuardPublic, and every
// path's OPTIONS preflight twin and Allow-Methods value derive from this
// single table (see command.Mount and command.AllowMethods).
package identity

import (
	"context"
	"net/http"

	"github.com/nevix-ai/server/internal/identity/auth"
	"github.com/nevix-ai/server/internal/identity/command"
)

func (m *Module) routes() []command.Route {
	return []command.Route{
		{
			Method:  http.MethodPost,
			Path:    "/identity/auth/login",
			Guard:   command.GuardPublic,
			Handler: command.Handle(m.auth.Login, auth.MapError, http.StatusOK),
		},
		{
			Method: http.MethodPost,
			Path:   "/identity/auth/logout",
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, _ auth.LogoutRequest) (auth.LogoutResponse, error) {
				principal, err := auth.PrincipalFrom(r)
				if err != nil {
					return auth.LogoutResponse{}, err
				}
				return m.auth.Logout(ctx, principal)
			}, auth.MapError, http.StatusOK),
		},
		{
			Method: http.MethodGet,
			Path:   "/identity/users/me",
			Handler: command.HandleNoBody(func(ctx context.Context, r *http.Request) (auth.MeResponse, error) {
				principal, err := auth.PrincipalFrom(r)
				if err != nil {
					return auth.MeResponse{}, err
				}
				return m.auth.Me(ctx, principal)
			}, auth.MapError, http.StatusOK),
		},
	}
}
