// The Module's trusted-command route table. The zero-value guard is
// RequireActiveUser: the team directory and the personal reads declare
// nothing; every governance command and the admin reads declare GuardAdmin;
// the two public entry commands — login and join-code self-registration —
// declare GuardPublic. Every path's OPTIONS preflight twin and Allow-Methods
// value derive from this single table (see command.Mount and
// command.AllowMethods). The zero-value password gate blocks a route while
// the caller owes the forced first-login change; me, logout, and the change
// itself declare PasswordGateOpen (issue #101); the governance surface stays
// gated (issue #102).
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
			// Self-registration (issue #121): redeem an active join code for a
			// new active-member account and its first session. Public like
			// login — the join code is the credential; a wrong or revoked code
			// and a closed registration (no active codes) are one answer.
			Method:  http.MethodPost,
			Path:    "/identity/register",
			Guard:   command.GuardPublic,
			Handler: command.Handle(m.auth.Register, auth.MapRegisterError, http.StatusCreated),
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
			// The team directory (issue #102): every active user reads the
			// active accounts' email and display name; the zero-value guard
			// carries that visibility decision.
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
			// Join-code governance (issue #120): issue, list, and revoke the
			// registration credentials; all three stay behind GuardAdmin and
			// the default password gate.
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
