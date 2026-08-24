// The self-registration command (issue #121, ADR-0015 2026-08-23 revision):
// someone holding a server URL and an active join code registers themselves
// an account — email and password of their own choosing, an optional display
// name, and the code an admin issued (issue #120). The account lands as an
// active member with no must_change_password (the credential is theirs from
// the first moment) and carries a session straight into the application. One
// write transaction holds the whole decision: the active code row is locked
// and validated, the account is inserted, the user_self_registered audit row
// commits with it, and the session is issued — all or nothing. Failures feed
// the same per-email limiter login uses; a wrong code and a locked-out
// deployment (no active codes) are the same answer, so the surface offers no
// enumeration gap.
package auth

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/command"
)

// errInvalidJoinCode is the uniform answer for a wrong code, a revoked code,
// and a deployment with no active codes at all: registration is closed or the
// caller is not invited, and the response never says which.
var errInvalidJoinCode = errors.New("auth: invalid join code")

// errEmailTaken answers a registration for an email another account already
// owns: the directory is single-tenant, so the conflict is said plainly
// rather than hidden behind the join-code answer.
var errEmailTaken = errors.New("auth: email already in use")

// errPasswordTooShort answers a password below the policy bound when it
// reaches the hashing seam (Validate normally catches it first).
var errPasswordTooShort = errors.New("auth: password must be at least 8 characters")

// RegisterRequest is the self-registration command body. Email, Password,
// and JoinCode are pointers so a body missing any of them is a shape failure
// (400), not a domain error.
type RegisterRequest struct {
	Email       *string `json:"email"`
	Password    *string `json:"password"`
	JoinCode    *string `json:"join_code"`
	DisplayName string  `json:"display_name,omitempty"`
}

// maxRegisterDisplayNameLength bounds an explicit display name, counted in
// characters to match the contract's maxLength semantics (the governance
// create command's bound).
const maxRegisterDisplayNameLength = 128

// Validate checks the request shape: present fields, a bare email address, a
// policy-valid password, and a bounded display name. The join code is only
// checked for presence here; whether any code is active is a domain fact the
// command's transaction answers.
func (r *RegisterRequest) Validate() *command.Error {
	if r.Email == nil || r.Password == nil || r.JoinCode == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with email, password, and join_code."}
	}
	if _, err := NormalizeEmail(*r.Email); err != nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_email", Message: "Email must be a bare address."}
	}
	if err := ValidateNewPassword(*r.Password); err != nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "password_too_short", Message: "Password must be at least 8 characters."}
	}
	// bcrypt's hard capacity: a longer password would fail inside the hasher,
	// so request validation rejects it with the change-password surface's
	// documented shape instead of surfacing that limit as a wrong verdict.
	if len(*r.Password) > maxPasswordBytes {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_password", Message: fmt.Sprintf("Password must be at most %d bytes.", maxPasswordBytes)}
	}
	if utf8.RuneCountInString(strings.TrimSpace(r.DisplayName)) > maxRegisterDisplayNameLength {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_display_name", Message: "Display name is too long."}
	}
	return nil
}

// Register redeems an active join code for a new active-member account and
// issues its first session in the response's Login-shaped body. Failed
// attempts feed the per-email limiter login uses (one attack key per email
// across both surfaces); bcrypt runs before the transaction, so a lockout
// bounds that cost too.
func (s *Service) Register(ctx context.Context, req RegisterRequest) (LoginResponse, error) {
	if req.Email == nil || req.Password == nil || req.JoinCode == nil {
		// Unreachable through the HTTP pipeline (Validate rejects it first);
		// guards direct callers against a nil dereference.
		return LoginResponse{}, fmt.Errorf("auth: register request missing email, password, or join code")
	}
	email, err := NormalizeEmail(*req.Email)
	if err != nil {
		// Unreachable past Validate; see Login's identical guard.
		return LoginResponse{}, errEmailTaken
	}
	if allowed, retryAfter := s.limiter.Allowed(email, time.Now()); !allowed {
		// Answer before any bcrypt work, exactly like login: a locked-out
		// email never pays for the attempt it is refused.
		return LoginResponse{}, errRateLimited{retryAfter: retryAfter}
	}
	passwordHash, err := HashPassword(*req.Password)
	if err != nil {
		return LoginResponse{}, errPasswordTooShort
	}
	// Crockford base32 is case-insensitive and codes are generated uppercase;
	// a code read aloud and typed lowercase still redeems.
	joinCode := strings.ToUpper(strings.TrimSpace(*req.JoinCode))
	displayName := strings.TrimSpace(req.DisplayName)
	if displayName == "" {
		displayName = derivedDisplayName(email)
	}

	token, tokenHash, err := newSessionToken()
	if err != nil {
		return LoginResponse{}, err
	}

	var registered userRecord
	var expiresAt time.Time
	err = s.runner.Run(ctx, func(tx pgx.Tx) error {
		// Lock the active code row: the validation decision holds until
		// commit, so a revocation racing this registration either waits or
		// has already closed the door.
		var codeID string
		err := tx.QueryRow(ctx,
			`SELECT id FROM public.join_codes WHERE code = $1 AND revoked_at IS NULL FOR UPDATE`,
			joinCode,
		).Scan(&codeID)
		if errors.Is(err, pgx.ErrNoRows) {
			return errInvalidJoinCode
		}
		if err != nil {
			return fmt.Errorf("auth: lock join code for register: %w", err)
		}

		err = tx.QueryRow(ctx,
			`INSERT INTO public.users (email, password_hash, display_name, role, status, must_change_password)
			 VALUES ($1, $2, $3, 'member', 'active', false)
			 RETURNING id, email, display_name, role, status, must_change_password`,
			email, passwordHash, displayName,
		).Scan(&registered.ID, &registered.Email, &registered.DisplayName, &registered.Role, &registered.Status, &registered.MustChangePassword)
		if isUsersEmailKeyViolation(err) {
			return errEmailTaken
		}
		if err != nil {
			return fmt.Errorf("auth: insert registered account: %w", err)
		}

		// The account enters the application with this session, so the
		// never-logged-in deletion protection starts here too.
		if _, err := tx.Exec(ctx,
			`UPDATE public.users SET last_login_at = now() WHERE id = $1`, registered.ID,
		); err != nil {
			return fmt.Errorf("auth: stamp registered first login: %w", err)
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO public.sessions (user_id, token_hash, expires_at)
			 VALUES ($1, $2, now() + make_interval(secs => $3))
			 RETURNING expires_at`,
			registered.ID, tokenHash, sessionTTL.Seconds(),
		).Scan(&expiresAt); err != nil {
			return fmt.Errorf("auth: insert registered session: %w", err)
		}

		actor, err := audit.SnapshotSubject(ctx, tx, registered.ID)
		if err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.Entry{
			Actor:    actor,
			Action:   audit.UserSelfRegistered,
			Metadata: map[string]string{"email": registered.Email, "join_code_id": codeID},
		})
	})
	if err != nil {
		if errors.Is(err, errInvalidJoinCode) || errors.Is(err, errEmailTaken) {
			s.limiter.RecordFailure(email, time.Now())
		}
		return LoginResponse{}, err
	}
	s.limiter.RecordSuccess(email)
	return LoginResponse{Token: token, ExpiresAt: expiresAt, User: userResponse(registered)}, nil
}

// isUsersEmailKeyViolation reports whether err is the users email unique
// constraint firing; the registration insert maps that violation to the
// email-taken answer.
func isUsersEmailKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "users_email_key"
}

// MapRegisterError maps the registration surface's domain errors to the
// public error envelope. It shares login's sentinels for the rate limit (the
// same limiter, its own machine code) and the account-disabled shape is
// unreachable here — registration creates the active account it answers with.
func MapRegisterError(err error) *command.Error {
	var limited errRateLimited
	if errors.As(err, &limited) {
		retrySeconds := int(math.Ceil(limited.retryAfter.Seconds()))
		return &command.Error{
			Status:  http.StatusTooManyRequests,
			Code:    "register_rate_limited",
			Message: "Too many failed registration attempts; try again later.",
			Headers: map[string]string{"Retry-After": fmt.Sprintf("%d", retrySeconds)},
		}
	}
	switch {
	case errors.Is(err, errInvalidJoinCode):
		return &command.Error{Status: http.StatusForbidden, Code: "invalid_join_code", Message: "The join code is not valid for registration."}
	case errors.Is(err, errEmailTaken):
		return &command.Error{Status: http.StatusConflict, Code: "email_taken", Message: "Another account already uses this email."}
	case errors.Is(err, errPasswordTooShort):
		return &command.Error{Status: http.StatusBadRequest, Code: "password_too_short", Message: "Password must be at least 8 characters."}
	default:
		return nil
	}
}
