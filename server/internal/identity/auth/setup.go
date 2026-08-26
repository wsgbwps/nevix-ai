// Instance Claim is the only path to the first Admin on an empty instance.
// Concurrent claims serialize under an advisory lock and re-check emptiness;
// optional setup codes exist only in process memory until a successful claim.
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

	"github.com/nevix-ai/server/internal/auditlog"
	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/session"
	"github.com/nevix-ai/server/internal/identity/writetx"
)

// claimAdvisoryLockKey serializes the empty-table check because row visibility
// alone cannot make a concurrent check-then-insert claim first-wins.
const claimAdvisoryLockKey = 0x534554555041444D

// setupCodeLength is the generated code's length: 8 Crockford base32
// characters, the same ~1.07e12 space as a join code — beyond any guessing
// budget while staying readable over a phone call.
const setupCodeLength = 8

// crockfordAlphabet is Crockford base32 without I, L, O, and U; 32 symbols
// divide 256 exactly, so one random byte selects one symbol without bias.
const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// errSetupCodeRequired answers a claim against a protected instance whose
// body carries no setup code: a shape failure for this deployment mode, not a
// wrong-credential verdict.
var errSetupCodeRequired = errors.New("auth: setup code required")

// errInvalidSetupCode answers a protected claim whose code does not match the
// one this process generated. It is the only wrong-code answer: an
// uninitialized instance's code is unknowable, and an initialized instance
// answers before the code is evaluated.
var errInvalidSetupCode = errors.New("auth: invalid setup code")

// errInstanceInitialized answers a claim against an instance that already has
// a user — another claim won the race first.
var errInstanceInitialized = errors.New("auth: instance already initialized")

// generateSetupCode returns a uniformly random code.
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

// ArmInstanceClaim arms the claim channel at Module construction per the
// deployment's protection choice: with setup-code required and an empty users
// table, it generates the code, discloses it to the operations log exactly
// once, and keeps it in process memory for the initialize command; against a
// populated table the channel does not exist — nothing is generated and
// nothing is logged — and an open instance never holds a code at all.
func (s *Service) ArmInstanceClaim(ctx context.Context, setupCodeRequired bool) error {
	s.setupCodeRequired = setupCodeRequired
	if !setupCodeRequired {
		return nil
	}
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
	slog.Warn("identity: no users exist; claim the instance with this one-time setup code",
		"setup_code", code[:4]+"-"+code[4:])
	return nil
}

// SetupStatusResponse is the public setup-status body: the two booleans the
// login screen needs, deliberately nothing else.
type SetupStatusResponse struct {
	Initialized       bool `json:"initialized"`
	SetupCodeRequired bool `json:"setup_code_required"`
}

// SetupStatus reports the instance's first-run state, read live so the answer
// reflects every committed claim. setup_code_required is true only while a
// claim would actually demand the code: the deployment enabled protection and
// the instance is still unclaimed; once initialized the code no longer
// exists, so the flag answers false regardless of configuration.
func (s *Service) SetupStatus(ctx context.Context) (SetupStatusResponse, error) {
	empty, err := s.usersEmpty(ctx)
	if err != nil {
		return SetupStatusResponse{}, err
	}
	return SetupStatusResponse{
		Initialized:       !empty,
		SetupCodeRequired: empty && s.setupCodeRequired,
	}, nil
}

// InitializeRequest is the instance-claim command body. Email and Password
// are pointers so a body missing either is a shape failure (400), not a
// domain error; SetupCode is optional because only a protected deployment
// demands it.
type InitializeRequest struct {
	Email       *string `json:"email"`
	Password    *string `json:"password"`
	SetupCode   *string `json:"setup_code"`
	DisplayName string  `json:"display_name,omitempty"`
}

// Validate checks the request shape against the same rules self-registration
// enforces: a bare email and a policy-valid password bounded by bcrypt's
// capacity, plus a display name within the contract's maxLength. Whether a
// setup code is required is a deployment fact the command answers.
func (r *InitializeRequest) Validate() *command.Error {
	if r.Email == nil || r.Password == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with email and password."}
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

// Initialize atomically claims an empty instance for its first Admin and
// issues the entry session. The advisory lock, emptiness re-check, optional
// setup-code check, user/session writes, and audit entry share one transaction.
// Success clears the in-memory setup code.
func (s *Service) Initialize(ctx context.Context, req InitializeRequest) (LoginResponse, error) {
	if req.Email == nil || req.Password == nil {
		// Unreachable through the HTTP pipeline (Validate rejects it first);
		// guards direct callers against a nil dereference.
		return LoginResponse{}, fmt.Errorf("auth: initialize request missing email or password")
	}
	email, err := NormalizeEmail(*req.Email)
	if err != nil {
		// Unreachable past Validate; see Login's identical guard.
		return LoginResponse{}, errInvalidCredentials
	}
	if allowed, retryAfter := s.limiter.Allowed(email, time.Now()); !allowed {
		// Answer before any bcrypt work, exactly like login and register.
		return LoginResponse{}, errRateLimited{retryAfter: retryAfter}
	}
	passwordHash, err := HashPassword(*req.Password)
	if err != nil {
		return LoginResponse{}, errPasswordTooShort
	}
	// Match the logged Crockford form case-insensitively and without separators.
	// Requirement is evaluated only after the transactional emptiness re-check.
	setupCode := ""
	if req.SetupCode != nil {
		setupCode = strings.ToUpper(strings.TrimSpace(*req.SetupCode))
		setupCode = strings.NewReplacer("-", "", " ", "").Replace(setupCode)
	}
	displayName := strings.TrimSpace(req.DisplayName)
	if displayName == "" {
		displayName = derivedDisplayName(email)
	}

	var claimed userRecord
	var issued session.IssuedSession
	err = s.runner.Run(ctx, func(sc *writetx.Scope) error {
		tx := sc.Tx()
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, claimAdvisoryLockKey); err != nil {
			return fmt.Errorf("auth: serialize instance claim: %w", err)
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM public.users)`).Scan(&exists); err != nil {
			return fmt.Errorf("auth: re-check users for claim: %w", err)
		}
		if exists {
			// Never evaluate setup credentials after the instance has a user.
			return errInstanceInitialized
		}
		if s.setupCodeRequired {
			if req.SetupCode == nil {
				return errSetupCodeRequired
			}
			if subtle.ConstantTimeCompare([]byte(setupCode), []byte(s.setupCode)) != 1 {
				return errInvalidSetupCode
			}
		}

		if err := tx.QueryRow(ctx,
			`INSERT INTO public.users (email, password_hash, display_name, role, status, must_change_password)
			 VALUES ($1, $2, $3, 'admin', 'active', false)
			 RETURNING id, email, display_name, role, status, must_change_password`,
			email, passwordHash, displayName,
		).Scan(&claimed.ID, &claimed.Email, &claimed.DisplayName, &claimed.Role, &claimed.Status, &claimed.MustChangePassword); err != nil {
			return fmt.Errorf("auth: insert claiming admin: %w", err)
		}
		// Issue the entry session and last-login projection in the same
		// transaction, using the credential state created above as its stamp.
		var err error
		issued, err = s.sessions.Issue(ctx, sc, session.IssueInput{
			UserID:          claimed.ID,
			CredentialStamp: passwordHash,
		})
		if err != nil {
			return fmt.Errorf("auth: issue claim session: %w", err)
		}
		actor, err := auditlog.SnapshotSubject(ctx, tx, claimed.ID)
		if err != nil {
			return err
		}
		return auditlog.Append(ctx, tx, auditlog.Entry{
			Actor:  actor,
			Action: auditlog.InstanceClaimed,
			Metadata: map[string]string{
				"email":               claimed.Email,
				"setup_code_required": fmt.Sprintf("%t", s.setupCodeRequired),
			},
		})
	})
	if err != nil {
		if errors.Is(err, errInvalidSetupCode) {
			s.limiter.RecordFailure(email, time.Now())
		}
		return LoginResponse{}, err
	}
	s.setupCode = ""
	s.limiter.RecordSuccess(email)
	return LoginResponse{Token: issued.Token, ExpiresAt: issued.ExpiresAt, User: userResponse(claimed)}, nil
}

// MapSetupError maps the claim surface's domain errors to the public error
// envelope. It shares login's rate-limit sentinel (the same limiter, its own
// machine code); concurrent claims serialize on one advisory lock, so
// instance_already_initialized is the only conflict this surface can answer.
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
	case errors.Is(err, errSetupCodeRequired):
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "This deployment requires a setup code; include setup_code in the request."}
	case errors.Is(err, errInvalidSetupCode):
		return &command.Error{Status: http.StatusForbidden, Code: "invalid_setup_code", Message: "The setup code is not valid."}
	case errors.Is(err, errInstanceInitialized):
		return &command.Error{Status: http.StatusConflict, Code: "instance_already_initialized", Message: "This instance already has an administrator."}
	default:
		return nil
	}
}

func (s *Service) usersEmpty(ctx context.Context) (bool, error) {
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM public.users)`).Scan(&exists); err != nil {
		return false, fmt.Errorf("identity: read users emptiness: %w", err)
	}
	return !exists, nil
}

func derivedDisplayName(email string) string {
	local, _, _ := strings.Cut(email, "@")
	return local
}
