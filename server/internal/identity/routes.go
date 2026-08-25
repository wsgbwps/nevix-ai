// This table is the authoritative guard and password-gate declaration for the
// Identity HTTP surface. Their zero values require an active user and a
// completed initial password change; exceptions must be explicit. OPTIONS and
// Allow-Methods derive from the same table.
package identity

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/auth"
	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/joincodes"
	"github.com/nevix-ai/server/internal/identity/users"
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
			Method:  http.MethodPost,
			Path:    "/identity/register",
			Guard:   command.GuardPublic,
			Handler: command.Handle(m.auth.Register, auth.MapRegisterError, http.StatusCreated),
		},
		{
			Method: http.MethodGet,
			Path:   "/identity/setup/status",
			Guard:  command.GuardPublic,
			Handler: command.HandleNoBody(func(ctx context.Context, _ *http.Request) (auth.SetupStatusResponse, error) {
				return m.auth.SetupStatus(ctx)
			}, auth.MapSetupError, http.StatusOK),
		},
		{
			Method:  http.MethodPost,
			Path:    "/identity/setup/initialize",
			Guard:   command.GuardPublic,
			Handler: command.Handle(m.auth.Initialize, auth.MapSetupError, http.StatusCreated),
		},
		{
			Method:       http.MethodPost,
			Path:         "/identity/auth/logout",
			PasswordGate: command.PasswordGateOpen,
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, _ auth.LogoutRequest) (auth.LogoutResponse, error) {
				principal, err := auth.PrincipalFrom(r)
				if err != nil {
					return auth.LogoutResponse{}, err
				}
				return m.auth.Logout(ctx, principal)
			}, auth.MapError, http.StatusOK),
		},
		{
			Method:       http.MethodPost,
			Path:         "/identity/auth/change-password",
			PasswordGate: command.PasswordGateOpen,
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, req auth.ChangePasswordRequest) (auth.ChangePasswordResponse, error) {
				principal, err := auth.PrincipalFrom(r)
				if err != nil {
					return auth.ChangePasswordResponse{}, err
				}
				return m.auth.ChangePassword(ctx, principal, req)
			}, auth.MapError, http.StatusOK),
		},
		{
			Method:       http.MethodGet,
			Path:         "/identity/users/me",
			PasswordGate: command.PasswordGateOpen,
			Handler: command.HandleNoBody(func(ctx context.Context, r *http.Request) (auth.MeResponse, error) {
				principal, err := auth.PrincipalFrom(r)
				if err != nil {
					return auth.MeResponse{}, err
				}
				return m.auth.Me(ctx, principal)
			}, auth.MapError, http.StatusOK),
		},
		{
			Method: http.MethodPatch,
			Path:   "/identity/users/me",
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, req auth.UpdateMeRequest) (auth.MeResponse, error) {
				principal, err := auth.PrincipalFrom(r)
				if err != nil {
					return auth.MeResponse{}, err
				}
				return m.auth.UpdateMe(ctx, principal, req)
			}, auth.MapError, http.StatusOK),
		},
		{
			Method:  http.MethodGet,
			Path:    "/identity/users",
			Handler: command.HandleNoBody(m.users.ListDirectory, users.MapError, http.StatusOK),
		},
		{
			Method: http.MethodPost,
			Path:   "/identity/users",
			Guard:  command.GuardAdmin,
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, req users.CreateRequest) (users.UserResponse, error) {
				principal, err := auth.PrincipalFrom(r)
				if err != nil {
					return users.UserResponse{}, err
				}
				return m.users.Create(ctx, principal, req)
			}, users.MapError, http.StatusCreated),
		},
		{
			Method:  http.MethodGet,
			Path:    "/identity/admin/users",
			Guard:   command.GuardAdmin,
			Handler: command.HandleNoBody(m.users.ListManagement, users.MapError, http.StatusOK),
		},
		{
			Method: http.MethodPost,
			Path:   "/identity/users/{userID}/disable",
			Guard:  command.GuardAdmin,
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, _ users.DisableRequest) (users.UserResponse, error) {
				principal, err := auth.PrincipalFrom(r)
				if err != nil {
					return users.UserResponse{}, err
				}
				return m.users.Disable(ctx, principal, chi.URLParam(r, "userID"))
			}, users.MapError, http.StatusOK),
		},
		{
			Method: http.MethodPost,
			Path:   "/identity/users/{userID}/reset-password",
			Guard:  command.GuardAdmin,
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, req users.ResetPasswordRequest) (users.UserResponse, error) {
				principal, err := auth.PrincipalFrom(r)
				if err != nil {
					return users.UserResponse{}, err
				}
				return m.users.ResetPassword(ctx, principal, chi.URLParam(r, "userID"), req)
			}, users.MapError, http.StatusOK),
		},
		{
			Method: http.MethodPost,
			Path:   "/identity/users/{userID}/email",
			Guard:  command.GuardAdmin,
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, req users.ChangeEmailRequest) (users.UserResponse, error) {
				principal, err := auth.PrincipalFrom(r)
				if err != nil {
					return users.UserResponse{}, err
				}
				return m.users.ChangeEmail(ctx, principal, chi.URLParam(r, "userID"), req)
			}, users.MapError, http.StatusOK),
		},
		{
			Method: http.MethodPost,
			Path:   "/identity/users/{userID}/role",
			Guard:  command.GuardAdmin,
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, req users.ChangeRoleRequest) (users.UserResponse, error) {
				principal, err := auth.PrincipalFrom(r)
				if err != nil {
					return users.UserResponse{}, err
				}
				return m.users.ChangeRole(ctx, principal, chi.URLParam(r, "userID"), req)
			}, users.MapError, http.StatusOK),
		},
		{
			Method: http.MethodDelete,
			Path:   "/identity/users/{userID}",
			Guard:  command.GuardAdmin,
			Handler: command.HandleNoBody(func(ctx context.Context, r *http.Request) (users.DeleteResponse, error) {
				principal, err := auth.PrincipalFrom(r)
				if err != nil {
					return users.DeleteResponse{}, err
				}
				return m.users.Delete(ctx, principal, chi.URLParam(r, "userID"))
			}, users.MapError, http.StatusOK),
		},
		{
			Method: http.MethodPost,
			Path:   "/identity/admin/join-codes",
			Guard:  command.GuardAdmin,
			Handler: command.HandleWithRequest(func(ctx context.Context, r *http.Request, req joincodes.CreateRequest) (joincodes.CreateResponse, error) {
				principal, err := auth.PrincipalFrom(r)
				if err != nil {
					return joincodes.CreateResponse{}, err
				}
				return m.joinCodes.Create(ctx, principal, req)
			}, joincodes.MapError, http.StatusCreated),
		},
		{
			Method: http.MethodGet,
			Path:   "/identity/admin/join-codes",
			Guard:  command.GuardAdmin,
			Handler: command.HandleNoBody(func(ctx context.Context, _ *http.Request) (joincodes.ListResponse, error) {
				return m.joinCodes.List(ctx)
			}, joincodes.MapError, http.StatusOK),
		},
		{
			Method: http.MethodDelete,
			Path:   "/identity/admin/join-codes/{joinCodeID}",
			Guard:  command.GuardAdmin,
			Handler: command.HandleNoBody(func(ctx context.Context, r *http.Request) (joincodes.RevokeResponse, error) {
				principal, err := auth.PrincipalFrom(r)
				if err != nil {
					return joincodes.RevokeResponse{}, err
				}
				return m.joinCodes.Revoke(ctx, principal, chi.URLParam(r, "joinCodeID"))
			}, joincodes.MapError, http.StatusOK),
		},
		{
			Method:  http.MethodGet,
			Path:    "/identity/audit-logs",
			Guard:   command.GuardAdmin,
			Handler: command.HandleNoBody(m.auditRead.List, audit.MapError, http.StatusOK),
		},
	}
}
