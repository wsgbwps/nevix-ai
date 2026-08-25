// Self-registration atomically redeems an active join code, creates an active
// Member, issues its first session, and records the audit entry. Wrong,
// revoked, and unavailable join codes share one response to avoid enumeration.
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
	"github.com/nevix-ai/server/internal/identity/session"
	"github.com/nevix-ai/server/internal/identity/writetx"
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

	var registered userRecord
	var issued session.IssuedSession
	err = s.runner.Run(ctx, func(sc *writetx.Scope) error {
		tx := sc.Tx()
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

		// Issue the entry session and last-login projection in the same
		// transaction, using the credential state created above as its stamp.
		issued, err = s.sessions.Issue(ctx, sc, session.IssueInput{
			UserID:          registered.ID,
			CredentialStamp: passwordHash,
		})
		if err != nil {
			return fmt.Errorf("auth: issue registered session: %w", err)
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
	return LoginResponse{Token: issued.Token, ExpiresAt: issued.ExpiresAt, User: userResponse(registered)}, nil
}

// isUsersEmailKeyViolation reports whether err is the users email unique
// constraint firing; the registration insert maps that violation to the
// email-taken answer.
func isUsersEmailKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "users_email_key"
}

// MapRegisterError maps registration domain errors to its public envelope.
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
