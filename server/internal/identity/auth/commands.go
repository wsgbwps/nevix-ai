// The auth Module commands: login (issue an opaque session), logout (revoke
// exactly the caller's session), and me (read the caller's account). Request
// validation, domain errors, and the error mapping follow the command
// skeleton's layering: request-shape failures answer 400 directly, domain
// errors pass through MapError.
package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/identity/command"
)

// errInvalidCredentials is the uniform answer for an unknown email and a wrong
// password alike: a failed login never reveals which one it was.
var errInvalidCredentials = errors.New("auth: invalid credentials")

// errAccountDisabled answers a correct login for a disabled account so the
// user learns the account is disabled rather than guessing their password
// failed (single-tenant directory: account existence is not a secret).
var errAccountDisabled = errors.New("auth: account disabled")

// errRateLimited carries the lockout's remaining duration.
type errRateLimited struct {
	retryAfter time.Duration
}

func (e errRateLimited) Error() string {
	return fmt.Sprintf("auth: login rate limited; retry after %s", e.retryAfter)
}

// errNoPrincipal marks a guarded route whose handler could not read the guard
// principal — a wiring bug, never a client condition.
var errNoPrincipal = errors.New("auth: guarded route ran without a principal")

const maxDeviceNameLength = 128

// UserResponse is the public shape of a user account.
type UserResponse struct {
	ID                 string `json:"id"`
	Email              string `json:"email"`
	DisplayName        string `json:"display_name"`
	Role               string `json:"role"`
	MustChangePassword bool   `json:"must_change_password"`
}

func userResponse(u userRecord) UserResponse {
	return UserResponse{
		ID:                 u.ID,
		Email:              u.Email,
		DisplayName:        u.DisplayName,
		Role:               u.Role,
		MustChangePassword: u.MustChangePassword,
	}
}

// LoginRequest is the login command body. Email and Password are pointers so
// the contract's shape rule is enforceable: a body missing either field is
// invalid_request (400), while a present-but-wrong or empty password is a
// credential failure (401).
type LoginRequest struct {
	Email      *string `json:"email"`
	Password   *string `json:"password"`
	DeviceName string  `json:"device_name,omitempty"`
}

// Validate checks the request shape. A missing email or password field is a
// shape failure; an empty-but-present password is not: it fails like any
// other wrong credential, keeping the login error surface uniform.
func (r *LoginRequest) Validate() *command.Error {
	if r.Email == nil || r.Password == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with email and password."}
	}
	if _, err := normalizeEmail(*r.Email); err != nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_email", Message: "Email must be a bare address."}
	}
	if len(r.DeviceName) > maxDeviceNameLength {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_device_name", Message: "Device name is too long."}
	}
	return nil
}

// LoginResponse returns the new session token and the authenticated user.
type LoginResponse struct {
	Token     string       `json:"token"`
	ExpiresAt time.Time    `json:"expires_at"`
	User      UserResponse `json:"user"`
}

// Login verifies credentials and issues one opaque session. Failed attempts
// feed the per-email limiter; a disabled account answers before any bcrypt
// work; a pending initial password still logs in, flagged in the response for
// the forced change flow, and logs the standing reminder.
func (s *Service) Login(ctx context.Context, req LoginRequest) (LoginResponse, error) {
	if req.Email == nil || req.Password == nil {
		// Unreachable through the HTTP pipeline (Validate rejects it first);
		// guards direct callers against a nil dereference.
		return LoginResponse{}, fmt.Errorf("auth: login request missing email or password")
	}
	email, err := normalizeEmail(*req.Email)
	if err != nil {
		return LoginResponse{}, errInvalidCredentials
	}
	password := *req.Password
	if allowed, retryAfter := s.limiter.Allowed(email, time.Now()); !allowed {
		return LoginResponse{}, errRateLimited{retryAfter: retryAfter}
	}

	user, err := s.loadUserByEmail(ctx, email)
	if errors.Is(err, pgx.ErrNoRows) {
		s.limiter.RecordFailure(email, time.Now())
		return LoginResponse{}, errInvalidCredentials
	}
	if err != nil {
		return LoginResponse{}, fmt.Errorf("auth: load user for login: %w", err)
	}
	if user.Status != "active" {
		return LoginResponse{}, errAccountDisabled
	}
	if !verifyPassword(user.PasswordHash, password) {
		s.limiter.RecordFailure(email, time.Now())
		return LoginResponse{}, errInvalidCredentials
	}

	token, tokenHash, err := newSessionToken()
	if err != nil {
		return LoginResponse{}, err
	}
	expiresAt, err := s.issueSession(ctx, user, tokenHash, req.DeviceName)
	if err != nil {
		return LoginResponse{}, err
	}
	s.limiter.RecordSuccess(email)
	if user.MustChangePassword {
		slog.Warn("identity: user logged in with an initial password that must be changed", "email", email)
	}
	return LoginResponse{Token: token, ExpiresAt: expiresAt, User: userResponse(user)}, nil
}

// LogoutRequest is the logout command body; the command takes no fields.
type LogoutRequest struct{}

// LogoutResponse confirms the session revocation.
type LogoutResponse struct {
	Status string `json:"status"`
}

// Logout revokes the caller's session only; every other device session stays
// valid (user story 5). Revoking an already-ended session is a success.
func (s *Service) Logout(ctx context.Context, principal authz.Principal) (LogoutResponse, error) {
	if err := s.revokeSession(ctx, principal); err != nil {
		return LogoutResponse{}, err
	}
	return LogoutResponse{Status: "logged_out"}, nil
}

// MeResponse is the /users/me body.
type MeResponse struct {
	User UserResponse `json:"user"`
}

// Me reads the caller's own account by id, reflecting any committed changes
// since the session was issued.
func (s *Service) Me(ctx context.Context, principal authz.Principal) (MeResponse, error) {
	user, err := s.loadUserByID(ctx, principal.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		// The guard proved an active user moments ago; a vanished row is a
		// consistency break, not a client condition.
		return MeResponse{}, fmt.Errorf("auth: session user %s no longer exists", principal.UserID)
	}
	if err != nil {
		return MeResponse{}, fmt.Errorf("auth: load user for me: %w", err)
	}
	return MeResponse{User: userResponse(user)}, nil
}

// PrincipalFrom recovers the guard-resolved principal for handlers, mapping a
// missing principal to errNoPrincipal.
func PrincipalFrom(r *http.Request) (authz.Principal, error) {
	principal, ok := authz.PrincipalFrom(r.Context())
	if !ok {
		return authz.Principal{}, fmt.Errorf("%w for %s", errNoPrincipal, r.URL.Path)
	}
	return principal, nil
}

// MapError maps the command's domain errors to the public error envelope.
func MapError(err error) *command.Error {
	var limited errRateLimited
	if errors.As(err, &limited) {
		retrySeconds := int(math.Ceil(limited.retryAfter.Seconds()))
		return &command.Error{
			Status:  http.StatusTooManyRequests,
			Code:    "login_rate_limited",
			Message: "Too many failed login attempts; try again later.",
			Headers: map[string]string{"Retry-After": fmt.Sprintf("%d", retrySeconds)},
		}
	}
	switch {
	case errors.Is(err, errInvalidCredentials):
		return &command.Error{Status: http.StatusUnauthorized, Code: "invalid_credentials", Message: "Email or password is incorrect."}
	case errors.Is(err, errAccountDisabled):
		return &command.Error{Status: http.StatusForbidden, Code: "account_disabled", Message: "This account is disabled."}
	case errors.Is(err, errNoPrincipal):
		return nil // 500: a guarded route without a principal is a wiring bug
	default:
		return nil
	}
}
