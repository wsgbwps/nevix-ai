// The admin governance commands (issue #102): create an account with an
// initial password, disable a departing member, reset a password, change a
// login email, adjust a role, and delete an account that never logged in.
// Each command is one Write Transaction Module run: the mutation, the session
// revocations it demands, and its audit row (with transaction-time actor and
// target snapshots, ADR-0009) commit together or not at all.
package users

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/auth"
	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/writetx"
)

// maxDisplayNameLength bounds an explicit display name on account creation,
// counted in characters to match the contract's maxLength semantics.
const maxDisplayNameLength = 128

// CreateRequest is the account-creation command body. Email and
// InitialPassword are pointers so a body missing either field is a shape
// failure (400) rather than a domain error.
type CreateRequest struct {
	Email           *string `json:"email"`
	InitialPassword *string `json:"initial_password"`
	DisplayName     string  `json:"display_name,omitempty"`
}

// Validate checks the request shape: present fields, a bare email address, a
// policy-valid initial password, and a bounded display name.
func (r *CreateRequest) Validate() *command.Error {
	if r.Email == nil || r.InitialPassword == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with email and initial_password."}
	}
	if _, err := auth.NormalizeEmail(*r.Email); err != nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_email", Message: "Email must be a bare address."}
	}
	if err := auth.ValidateNewPassword(*r.InitialPassword); err != nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "password_too_short", Message: "Initial password must be at least 8 characters."}
	}
	if utf8.RuneCountInString(strings.TrimSpace(r.DisplayName)) > maxDisplayNameLength {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_display_name", Message: "Display name is too long."}
	}
	return nil
}

// Create inserts a member account with the admin-set initial password. The
// account arrives with must_change_password set, so the first login forces
// the credential change flow (ADR-0015); the creation audit row commits in
// the same transaction.
func (s *Service) Create(ctx context.Context, principal authz.Principal, req CreateRequest) (UserResponse, error) {
	email, err := auth.NormalizeEmail(*req.Email)
	if err != nil {
		// Unreachable through the HTTP pipeline (Validate rejects it first);
		// guards direct callers against a rejected email reaching the insert.
		return UserResponse{}, errEmailTaken
	}
	passwordHash, err := auth.HashPassword(*req.InitialPassword)
	if err != nil {
		return UserResponse{}, errPasswordTooShort
	}
	displayName := strings.TrimSpace(req.DisplayName)
	if displayName == "" {
		displayName = localPart(email)
	}

	var created userRecord
	err = s.runner.Run(ctx, func(sc *writetx.Scope) error {
		tx := sc.Tx()
		if err := tx.QueryRow(ctx,
			`INSERT INTO public.users (email, password_hash, display_name, role, status, must_change_password)
			 VALUES ($1, $2, $3, 'member', 'active', true)
			 RETURNING id, email, display_name, role, status, must_change_password, last_login_at, created_at, updated_at`,
			email, passwordHash, displayName,
		).Scan(&created.ID, &created.Email, &created.DisplayName, &created.Role, &created.Status,
			&created.MustChangePassword, &created.LastLoginAt, &created.CreatedAt, &created.UpdatedAt); err != nil {
			if isUniqueViolation(err, "users_email_key") {
				return errEmailTaken
			}
			return fmt.Errorf("users: insert account: %w", err)
		}
		return s.writeAudit(ctx, tx, principal.UserID, &audit.Subject{UserID: created.ID, DisplayName: created.DisplayName},
			audit.UserCreated, map[string]string{"email": created.Email})
	})
	if err != nil {
		return UserResponse{}, err
	}
	return UserResponse{User: managementEntry(created)}, nil
}

// DisableRequest is the disable command body; the command takes no fields.
type DisableRequest struct{}

// Disable deactivates an account and revokes every one of its sessions in
// the same transaction, so a disabled member's live tokens fail their very
// next request. Disabling an already-disabled account is a successful no-op
// (mirroring logout's semantics); disabling the last active admin —
// including the caller's own account — is refused.
func (s *Service) Disable(ctx context.Context, principal authz.Principal, userID string) (UserResponse, error) {
	var user userRecord
	err := s.runner.Run(ctx, func(sc *writetx.Scope) error {
		tx := sc.Tx()
		loaded, err := s.loadUserForUpdate(ctx, tx, userID)
		if err != nil {
			return err
		}
		user = loaded
		if user.Status != "active" {
			return nil // already disabled: idempotent success, nothing to audit
		}
		if err := s.refuseLastActiveAdminReduction(ctx, tx, user); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE public.users SET status = 'disabled', updated_at = now() WHERE id = $1`, user.ID,
		); err != nil {
			return fmt.Errorf("users: disable account: %w", err)
		}
		if err := revokeAllSessions(ctx, tx, user.ID); err != nil {
			return err
		}
		user.Status = "disabled"
		return s.writeAudit(ctx, tx, principal.UserID, &audit.Subject{UserID: user.ID, DisplayName: user.DisplayName},
			audit.UserDisabled, nil)
	})
	if err != nil {
		return UserResponse{}, err
	}
	return UserResponse{User: managementEntry(user)}, nil
}

// ResetPasswordRequest is the password-reset command body.
type ResetPasswordRequest struct {
	InitialPassword *string `json:"initial_password"`
}

// Validate checks the request shape: the new initial password must be
// present and policy-valid.
func (r *ResetPasswordRequest) Validate() *command.Error {
	if r.InitialPassword == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with initial_password."}
	}
	if err := auth.ValidateNewPassword(*r.InitialPassword); err != nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "password_too_short", Message: "Initial password must be at least 8 characters."}
	}
	return nil
}

// ResetPassword sets a new admin-chosen initial password on an account:
// must_change_password is re-armed and every existing session for the
// account is revoked in the same transaction (ADR-0015 credential hygiene).
func (s *Service) ResetPassword(ctx context.Context, principal authz.Principal, userID string, req ResetPasswordRequest) (UserResponse, error) {
	passwordHash, err := auth.HashPassword(*req.InitialPassword)
	if err != nil {
		return UserResponse{}, errPasswordTooShort
	}

	var user userRecord
	err = s.runner.Run(ctx, func(sc *writetx.Scope) error {
		tx := sc.Tx()
		loaded, err := s.loadUserForUpdate(ctx, tx, userID)
		if err != nil {
			return err
		}
		user = loaded
		if _, err := tx.Exec(ctx,
			`UPDATE public.users
			 SET password_hash = $2, must_change_password = true, updated_at = now()
			 WHERE id = $1`,
			user.ID, passwordHash,
		); err != nil {
			return fmt.Errorf("users: reset password: %w", err)
		}
		if err := revokeAllSessions(ctx, tx, user.ID); err != nil {
			return err
		}
		user.MustChangePassword = true
		return s.writeAudit(ctx, tx, principal.UserID, &audit.Subject{UserID: user.ID, DisplayName: user.DisplayName},
			audit.UserPasswordReset, nil)
	})
	if err != nil {
		return UserResponse{}, err
	}
	return UserResponse{User: managementEntry(user)}, nil
}

// ChangeEmailRequest is the email-change command body.
type ChangeEmailRequest struct {
	Email *string `json:"email"`
}

// Validate checks the request shape: the new email must be present and a
// bare address.
func (r *ChangeEmailRequest) Validate() *command.Error {
	if r.Email == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with email."}
	}
	if _, err := auth.NormalizeEmail(*r.Email); err != nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_email", Message: "Email must be a bare address."}
	}
	return nil
}

// ChangeEmail moves an account's unique login identifier. Email is
// admin-only mutable (ADR-0015): the guard has already proved the caller;
// the from/to pair rides the audit row so the trail shows the exact move.
func (s *Service) ChangeEmail(ctx context.Context, principal authz.Principal, userID string, req ChangeEmailRequest) (UserResponse, error) {
	email, err := auth.NormalizeEmail(*req.Email)
	if err != nil {
		return UserResponse{}, errEmailTaken // unreachable past Validate; see Create
	}

	var user userRecord
	err = s.runner.Run(ctx, func(sc *writetx.Scope) error {
		tx := sc.Tx()
		loaded, err := s.loadUserForUpdate(ctx, tx, userID)
		if err != nil {
			return err
		}
		user = loaded
		if _, err := tx.Exec(ctx,
			`UPDATE public.users SET email = $2, updated_at = now() WHERE id = $1`,
			user.ID, email,
		); err != nil {
			if isUniqueViolation(err, "users_email_key") {
				return errEmailTaken
			}
			return fmt.Errorf("users: change email: %w", err)
		}
		user.Email = email
		return s.writeAudit(ctx, tx, principal.UserID, &audit.Subject{UserID: user.ID, DisplayName: user.DisplayName},
			audit.UserEmailChanged, map[string]string{"from": loaded.Email, "to": email})
	})
	if err != nil {
		return UserResponse{}, err
	}
	return UserResponse{User: managementEntry(user)}, nil
}

// ChangeRoleRequest is the role-change command body.
type ChangeRoleRequest struct {
	Role *string `json:"role"`
}

// Validate checks the request shape: the role must be present and one of the
// two deployment roles.
func (r *ChangeRoleRequest) Validate() *command.Error {
	if r.Role == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with role."}
	}
	if *r.Role != "admin" && *r.Role != "member" {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_role", Message: "Role must be admin or member."}
	}
	return nil
}

// ChangeRole switches an account between member and admin. Demoting the last
// active admin — including the caller's own account — is refused so the
// deployment always keeps a usable admin (ADR-0015).
func (s *Service) ChangeRole(ctx context.Context, principal authz.Principal, userID string, req ChangeRoleRequest) (UserResponse, error) {
	var user userRecord
	err := s.runner.Run(ctx, func(sc *writetx.Scope) error {
		tx := sc.Tx()
		loaded, err := s.loadUserForUpdate(ctx, tx, userID)
		if err != nil {
			return err
		}
		user = loaded
		if user.Role == "admin" && user.Status == "active" && *req.Role == "member" {
			if err := s.refuseLastActiveAdminReduction(ctx, tx, user); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx,
			`UPDATE public.users SET role = $2, updated_at = now() WHERE id = $1`,
			user.ID, *req.Role,
		); err != nil {
			return fmt.Errorf("users: change role: %w", err)
		}
		user.Role = *req.Role
		return s.writeAudit(ctx, tx, principal.UserID, &audit.Subject{UserID: user.ID, DisplayName: user.DisplayName},
			audit.UserRoleChanged, map[string]string{"from": loaded.Role, "to": *req.Role})
	})
	if err != nil {
		return UserResponse{}, err
	}
	return UserResponse{User: managementEntry(user)}, nil
}

// DeleteResponse confirms the deletion.
type DeleteResponse struct {
	Status string `json:"status"`
}

// Delete removes an account that never logged in — the only deletable kind:
// accounts with history stay as disabled rows so attribution survives
// (ADR-0015). The last-active-admin invariant cannot be broken by deletion:
// the caller is an active admin with a live session, so the target is either
// someone else (the caller remains) or the caller, whom the never-logged-in
// rule already rejects.
func (s *Service) Delete(ctx context.Context, principal authz.Principal, userID string) (DeleteResponse, error) {
	err := s.runner.Run(ctx, func(sc *writetx.Scope) error {
		tx := sc.Tx()
		user, err := s.loadUserForUpdate(ctx, tx, userID)
		if err != nil {
			return err
		}
		if user.LastLoginAt != nil {
			return errUserHasLoggedIn
		}
		if _, err := tx.Exec(ctx, `DELETE FROM public.users WHERE id = $1`, user.ID); err != nil {
			return fmt.Errorf("users: delete account: %w", err)
		}
		// The audit row deliberately outlives the account row it names
		// (ADR-0009): the target snapshot and the email recorded in metadata
		// keep the trail readable after the deletion.
		return s.writeAudit(ctx, tx, principal.UserID, &audit.Subject{UserID: user.ID, DisplayName: user.DisplayName},
			audit.UserDeleted, map[string]string{"email": user.Email})
	})
	if err != nil {
		return DeleteResponse{}, err
	}
	return DeleteResponse{Status: "deleted"}, nil
}

// refuseLastActiveAdminReduction blocks a demotion or disable that would
// leave the deployment without any active admin. It must run inside the
// caller's write transaction: the row locks serialize concurrent reductions
// and keep the count honest until commit (see countOtherActiveAdminsLocked).
func (s *Service) refuseLastActiveAdminReduction(ctx context.Context, tx pgx.Tx, user userRecord) error {
	others, err := countOtherActiveAdminsLocked(ctx, tx, user.ID)
	if err != nil {
		return fmt.Errorf("users: count active admins: %w", err)
	}
	if others == 0 {
		return errLastAdminProtected
	}
	return nil
}

// revokeAllSessions deletes every session row of one account inside the
// caller's transaction. Disabled or credential-reset accounts lose access on
// their very next request, not at token expiry.
func revokeAllSessions(ctx context.Context, tx pgx.Tx, userID string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM public.sessions WHERE user_id = $1`, userID); err != nil {
		return fmt.Errorf("users: revoke sessions: %w", err)
	}
	return nil
}

// writeAudit snapshots the acting admin inside the transaction and appends
// the governance audit row (ADR-0009: snapshot at write time, same
// transaction as the mutation).
func (s *Service) writeAudit(ctx context.Context, tx pgx.Tx, actorUserID string, target *audit.Subject, action audit.Action, metadata map[string]string) error {
	actor, err := audit.SnapshotSubject(ctx, tx, actorUserID)
	if err != nil {
		return err
	}
	return audit.Write(ctx, tx, audit.Entry{Actor: actor, Target: target, Action: action, Metadata: metadata})
}

// isUniqueViolation reports whether err is the named unique constraint
// firing; the users_email_key violation is the email-taken answer.
func isUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == constraint
}

// localPart derives a display name from an email's local part; the user
// renames it later at will (the bootstrap rule).
func localPart(email string) string {
	local, _, _ := strings.Cut(email, "@")
	return local
}
