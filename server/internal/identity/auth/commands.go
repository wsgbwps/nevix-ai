// Authentication commands keep request-shape validation separate from
// domain-to-HTTP error mapping.
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

	"github.com/nevix-ai/server/internal/auditlog"
	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/session"
	"github.com/nevix-ai/server/internal/identity/writetx"
)

// ErrInvalidCredentials is the uniform answer for an unknown email and a wrong
// password alike: a failed login never reveals which one it was. Exported so
// the reauth proof command can answer the same sentinel from its lock-point
// credential recheck and map it through the same single error owner.
var ErrInvalidCredentials = errors.New("auth: invalid credentials")

// errInvalidCredentials is retained as the internal spelling the auth
// commands were written against.
var errInvalidCredentials = ErrInvalidCredentials

// ErrAccountDisabled answers a correct login for a disabled account so the
// user learns the account is disabled rather than guessing their password
// failed (single-tenant directory: account existence is not a secret).
var ErrAccountDisabled = errors.New("auth: account disabled")

// errAccountDisabled is retained as the internal spelling the auth commands
// were written against.
var errAccountDisabled = ErrAccountDisabled

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
	if _, err := NormalizeEmail(*r.Email); err != nil {
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
	email, err := NormalizeEmail(*req.Email)
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

	// The account row lock re-checks this verified password hash before issuing,
	// so a concurrent disable or reset that commits first cannot leave a stale
	// session behind.
	var token string
	var expiresAt time.Time
	err = s.runner.Run(ctx, func(sc *writetx.Scope) error {
		issued, err := s.sessions.Issue(ctx, sc, session.IssueInput{
			UserID:          user.ID,
			DeviceName:      req.DeviceName,
			CredentialStamp: user.PasswordHash,
		})
		if errors.Is(err, session.ErrInactiveUser) {
			return errAccountDisabled
		}
		if errors.Is(err, session.ErrStaleCredential) {
			// The credential changed between verification and the issuance
			// lock point (an admin reset landed in between): the same uniform
			// answer as any other wrong password.
			return errInvalidCredentials
		}
		if err != nil {
			return err
		}
		// The audit actor is snapshotted inside the transaction (ADR-0009):
		// the display name recorded is the one committed at write time, not
		// one read before the transaction.
		actor, err := auditlog.SnapshotSubject(ctx, sc.Tx(), user.ID)
		if err != nil {
			return err
		}
		metadata := map[string]string{}
		if req.DeviceName != "" {
			metadata["device_name"] = req.DeviceName
		}
		if err := auditlog.Append(ctx, sc.Tx(), auditlog.Entry{
			Actor:    actor,
			Action:   auditlog.SessionCreated,
			Metadata: metadata,
		}); err != nil {
			return err
		}
		token, expiresAt = issued.Token, issued.ExpiresAt
		return nil
	})
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

// Logout revokes only the caller's session. An already-ended session is a
// successful no-op; only an actual revocation writes an audit entry.
func (s *Service) Logout(ctx context.Context, principal authz.Principal) (LogoutResponse, error) {
	// Input validation, not transactional work: a principal without a
	// session identity is a wiring bug, refused before the transaction.
	current, err := session.Current(principal.SessionID)
	if err != nil {
		return LogoutResponse{}, err
	}
	err = s.runner.Run(ctx, func(sc *writetx.Scope) error {
		changed, err := s.sessions.Revoke(ctx, sc, current)
		if err != nil {
			return err
		}
		if !changed {
			return nil
		}
		// The audit actor is snapshotted inside the transaction (ADR-0009):
		// the display name recorded is the one committed at write time.
		actor, err := auditlog.SnapshotSubject(ctx, sc.Tx(), principal.UserID)
		if err != nil {
			return err
		}
		return auditlog.Append(ctx, sc.Tx(), auditlog.Entry{
			Actor:  actor,
			Action: auditlog.SessionRevoked,
		})
	})
	if err != nil {
		return LogoutResponse{}, err
	}
	return LogoutResponse{Status: "logged_out"}, nil
}

// ReverifyCurrentPassword re-verifies the caller's current password for a
// re-verification command (Reauthentication Proof issuance, issue #154):
// the shared per-email login limiter, a fresh committed active-status read,
// and bcrypt verification against the committed hash — the same single
// credential owner as login, exported so the proof command cannot grow a
// second verification path. On success it returns the committed hash as the
// credential stamp the caller must recheck under its issuance row lock, so a
// concurrent change that commits first cannot leave a stale-credential proof
// behind (the session issuance discipline). Failures return the same
// sentinels login maps (errRateLimited, ErrAccountDisabled,
// ErrInvalidCredentials), so callers reuse auth.MapError for them; a
// successful verification clears the email's counted failures exactly like
// a successful login.
func (s *Service) ReverifyCurrentPassword(ctx context.Context, principal authz.Principal, password string) (string, error) {
	if allowed, retryAfter := s.limiter.Allowed(principal.Email, time.Now()); !allowed {
		return "", errRateLimited{retryAfter: retryAfter}
	}
	user, err := s.loadUserByID(ctx, principal.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		// The guard proved an active user moments ago; a vanished row is a
		// consistency break, not a client condition.
		return "", fmt.Errorf("auth: session user %s no longer exists", principal.UserID)
	}
	if err != nil {
		return "", fmt.Errorf("auth: load user for reverification: %w", err)
	}
	if user.Status != "active" {
		return "", errAccountDisabled
	}
	if !verifyPassword(user.PasswordHash, password) {
		s.limiter.RecordFailure(principal.Email, time.Now())
		return "", errInvalidCredentials
	}
	s.limiter.RecordSuccess(principal.Email)
	return user.PasswordHash, nil
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
