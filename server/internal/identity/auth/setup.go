// The first-run setup-code channel (issue #122, ADR-0015 2026-08-23
// revision): on an instance with no users, Module construction generates a
// one-time setup code — eight Crockford base32 characters disclosed once in
// the operations log and held only in process memory. Whoever holds it
// initializes the instance through the setup wizard, choosing their own
// email, password, and display name and becoming the first admin with the
// session the response carries (the password is theirs from the first
// moment, so must_change_password stays false). The environment-variable
// bootstrap channel stays for headless delivery and E2E; the two channels
// serialize on one transaction-scoped advisory lock with an empty-table
// re-check — first writer wins, the initialize loser answers 409 — and once
// any user exists the setup code no longer exists: construction never
// generates one against a populated instance, and every initialize
// re-proves emptiness under the lock before the code is even evaluated.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/command"
)

// setupAdvisoryLockKey serializes the two first-admin channels
// (0x534554555041444D spells "SETUPADM"): setup-code initialize and the
// environment bootstrap both re-check the empty users table inside this
// transaction-scoped lock, so exactly one of them can ever observe emptiness
// and commit the first admin; see joinCodeCapLockKey for why row visibility
// alone cannot serialize a count-then-insert decision.
const setupAdvisoryLockKey = 0x534554555041444D

// setupCodeLength is the generated code's length: 8 Crockford base32
// characters, the same ~1.07e12 space as a join code — beyond any guessing
// budget while staying readable over a phone call.
const setupCodeLength = 8

// crockfordAlphabet is Crockford base32 without I, L, O, and U; 32 symbols
// divide 256 exactly, so one random byte selects one symbol without bias.
const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// errInvalidSetupCode answers a setup attempt whose code does not match the
// one this process generated. It is the only wrong-code answer: an
// uninitialized instance's code is unknowable, and an initialized instance
// answers before the code is evaluated.
var errInvalidSetupCode = errors.New("auth: invalid setup code")

// errInstanceInitialized answers an initialize attempt against an instance
// that already has a user — either channel won the first-admin race first.
var errInstanceInitialized = errors.New("auth: instance already initialized")

// generateSetupCode returns one uniformly random code string (the same
// generator shape the join-code service owns; each package owns its own
// credential format).
func generateSetupCode() (string, error) {
	raw := make([]byte, setupCodeLength)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("auth: read setup-code randomness: %w", err)
	}
	code := make([]byte, setupCodeLength)
	for i, b := range raw {
		code[i] = crockfordAlphabet[int(b)%len(crockfordAlphabet)]
	}
	return string(code), nil
}

// GenerateSetupCode arms the setup channel at Module construction: on an
// empty users table it generates the code, discloses it to the operations
// log exactly once, and keeps it in process memory for the initialize
// command; against a populated table the channel does not exist — nothing
// is generated and nothing is logged.
func (s *Service) GenerateSetupCode(ctx context.Context) error {
	empty, err := s.usersEmpty(ctx)
	if err != nil {
		return err
	}
	if !empty {
		return nil
	}
	code, err := generateSetupCode()
	if err != nil {
		return err
	}
	s.setupCode = code
	slog.Warn("identity: no users exist; initialize the instance with this one-time first-run setup code",
		"setup_code", code[:4]+"-"+code[4:])
	return nil
}

// SetupStatusResponse is the public setup-status body: the one boolean the
// login screen needs, deliberately nothing else.
type SetupStatusResponse struct {
	Initialized bool `json:"initialized"`
}

// SetupStatus reports whether the instance already has a user, read live so
// the answer reflects every committed first-admin channel.
func (s *Service) SetupStatus(ctx context.Context) (SetupStatusResponse, error) {
	empty, err := s.usersEmpty(ctx)
	if err != nil {
		return SetupStatusResponse{}, err
	}
	return SetupStatusResponse{Initialized: !empty}, nil
}

// InitializeRequest is the setup-initialize command body. Email, Password,
// and SetupCode are pointers so a body missing any of them is a shape
// failure (400), not a domain error.
type InitializeRequest struct {
	Email       *string `json:"email"`
	Password    *string `json:"password"`
	SetupCode   *string `json:"setup_code"`
	DisplayName string  `json:"display_name,omitempty"`
}

// Validate checks the request shape against the same rules self-registration
// enforces: a bare email, a policy-valid password bounded by bcrypt's
// capacity, and a display name within the contract's maxLength. The setup
// code is only checked for presence here; whether it matches is a domain
// fact the command's transaction answers.
func (r *InitializeRequest) Validate() *command.Error {
	if r.Email == nil || r.Password == nil || r.SetupCode == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with email, password, and setup_code."}
	}
	if _, err := NormalizeEmail(*r.Email); err != nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_email", Message: "Email must be a bare address."}
	}
	if err := ValidateNewPassword(*r.Password); err != nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "password_too_short", Message: "Password must be at least 8 characters."}
	}
	if len(*r.Password) > maxPasswordBytes {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_password", Message: fmt.Sprintf("Password must be at most %d bytes.", maxPasswordBytes)}
	}
	if utf8.RuneCountInString(strings.TrimSpace(r.DisplayName)) > maxRegisterDisplayNameLength {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_display_name", Message: "Display name is too long."}
	}
	return nil
}

// Initialize redeems the setup code for the instance's first admin and the
// session that carries the wizard straight into the application. One write
// transaction holds the whole decision: the first-admin advisory lock, the
// empty-table re-check (both bootstrap channels serialize here — the loser
// answers 409), the constant-time code comparison, the admin insert with
// must_change_password=false, the last-login stamp, the session, and the
// setup_admin_created audit row. A wrong code feeds the per-email limiter
// login and registration share, so guessing budgets face the same lockout.
func (s *Service) Initialize(ctx context.Context, req InitializeRequest) (LoginResponse, error) {
	if req.Email == nil || req.Password == nil || req.SetupCode == nil {
		// Unreachable through the HTTP pipeline (Validate rejects it first);
		// guards direct callers against a nil dereference.
		return LoginResponse{}, fmt.Errorf("auth: initialize request missing email, password, or setup code")
	}
	email, err := NormalizeEmail(*req.Email)
	if err != nil {
		// Unreachable past Validate; see Login's identical guard.
		return LoginResponse{}, errInvalidSetupCode
	}
	if allowed, retryAfter := s.limiter.Allowed(email, time.Now()); !allowed {
		// Answer before any bcrypt work, exactly like login and register.
		return LoginResponse{}, errRateLimited{retryAfter: retryAfter}
	}
	passwordHash, err := HashPassword(*req.Password)
	if err != nil {
		return LoginResponse{}, errPasswordTooShort
	}
	// Crockford base32 is case-insensitive and codes are generated uppercase;
	// a code read aloud and typed lowercase still initializes.
	setupCode := strings.ToUpper(strings.TrimSpace(*req.SetupCode))
	displayName := strings.TrimSpace(req.DisplayName)
	if displayName == "" {
		displayName = bootstrapDisplayName(email)
	}

	token, tokenHash, err := newSessionToken()
	if err != nil {
		return LoginResponse{}, err
	}

	var initialized userRecord
	var expiresAt time.Time
	err = s.runner.Run(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, setupAdvisoryLockKey); err != nil {
			return fmt.Errorf("auth: serialize setup initialize: %w", err)
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM public.users)`).Scan(&exists); err != nil {
			return fmt.Errorf("auth: re-check users for initialize: %w", err)
		}
		if exists {
			// First-wins against the environment channel and concurrent
			// attempts alike; the code is never evaluated on this path.
			return errInstanceInitialized
		}
		if subtle.ConstantTimeCompare([]byte(setupCode), []byte(s.setupCode)) != 1 {
			return errInvalidSetupCode
		}

		if err := tx.QueryRow(ctx,
			`INSERT INTO public.users (email, password_hash, display_name, role, status, must_change_password)
			 VALUES ($1, $2, $3, 'admin', 'active', false)
			 RETURNING id, email, display_name, role, status, must_change_password`,
			email, passwordHash, displayName,
		).Scan(&initialized.ID, &initialized.Email, &initialized.DisplayName, &initialized.Role, &initialized.Status, &initialized.MustChangePassword); err != nil {
			return fmt.Errorf("auth: insert setup admin: %w", err)
		}
		// The account enters the application with this session, so the
		// never-logged-in deletion protection starts here too.
		if _, err := tx.Exec(ctx,
			`UPDATE public.users SET last_login_at = now() WHERE id = $1`, initialized.ID,
		); err != nil {
			return fmt.Errorf("auth: stamp setup first login: %w", err)
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO public.sessions (user_id, token_hash, expires_at)
			 VALUES ($1, $2, now() + make_interval(secs => $3))
			 RETURNING expires_at`,
			initialized.ID, tokenHash, sessionTTL.Seconds(),
		).Scan(&expiresAt); err != nil {
			return fmt.Errorf("auth: insert setup session: %w", err)
		}
		actor, err := audit.SnapshotSubject(ctx, tx, initialized.ID)
		if err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.Entry{
			Actor:    actor,
			Action:   audit.SetupAdminCreated,
			Metadata: map[string]string{"email": initialized.Email},
		})
	})
	if err != nil {
		if errors.Is(err, errInvalidSetupCode) {
			s.limiter.RecordFailure(email, time.Now())
		}
		return LoginResponse{}, err
	}
	s.limiter.RecordSuccess(email)
	return LoginResponse{Token: token, ExpiresAt: expiresAt, User: userResponse(initialized)}, nil
}

// MapSetupError maps the setup surface's domain errors to the public error
// envelope. It shares login's rate-limit sentinel (the same limiter, its own
// machine code); the two bootstrap channels serialize on one advisory lock,
// so instance_already_initialized is the only conflict this surface can
// answer.
func MapSetupError(err error) *command.Error {
	var limited errRateLimited
	if errors.As(err, &limited) {
		retrySeconds := int(math.Ceil(limited.retryAfter.Seconds()))
		return &command.Error{
			Status:  http.StatusTooManyRequests,
			Code:    "setup_rate_limited",
			Message: "Too many failed setup attempts; try again later.",
			Headers: map[string]string{"Retry-After": fmt.Sprintf("%d", retrySeconds)},
		}
	}
	switch {
	case errors.Is(err, errInvalidSetupCode):
		return &command.Error{Status: http.StatusForbidden, Code: "invalid_setup_code", Message: "The setup code is not valid."}
	case errors.Is(err, errInstanceInitialized):
		return &command.Error{Status: http.StatusConflict, Code: "instance_already_initialized", Message: "This instance already has an administrator."}
	default:
		return nil
	}
}
