// Self-service account commands (issue #101): change own password (the
// first-login forced change and everyday rotation share one command) and
// update own display name. Layering follows the command skeleton: shape
// failures answer 400 from Validate; domain failures map through MapError;
// every write runs through the Write Transaction Module with its audit row
// in the same transaction (ADR-0009). Credential verification for the
// change runs inside that transaction under a row lock, so exactly one
// concurrent change (self-service or a future admin reset) can succeed
// against one committed hash.
package auth

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/session"
	"github.com/nevix-ai/server/internal/identity/writetx"
)

// maxDisplayNameLength bounds display names in Unicode characters — the
// same counting the contract's maxLength uses, never bytes.
const maxDisplayNameLength = 128

// ChangePasswordRequest is the change-password command body. Both fields are
// pointers so the shape rule is enforceable: a body missing either field is
// invalid_request (400), while a present-but-wrong current password is a
// credential failure (401).
type ChangePasswordRequest struct {
	CurrentPassword *string `json:"current_password"`
	NewPassword     *string `json:"new_password"`
}

// Validate checks the request shape and the new-password policy. An
// empty-but-present current password is not a shape failure: it fails
// verification like any other wrong credential. The new password is bounded
// by the bcrypt capacity so a policy-conformant input can never surface the
// hasher's limit as a 500.
func (r *ChangePasswordRequest) Validate() *command.Error {
	if r.CurrentPassword == nil || r.NewPassword == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with current_password and new_password."}
	}
	if len(*r.NewPassword) < minPasswordLength {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_password", Message: fmt.Sprintf("Password must be at least %d characters.", minPasswordLength)}
	}
	if len(*r.NewPassword) > maxPasswordBytes {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_password", Message: fmt.Sprintf("Password must be at most %d bytes.", maxPasswordBytes)}
	}
	return nil
}

// ChangePasswordResponse confirms the rotation.
type ChangePasswordResponse struct {
	Status string `json:"status"`
}

// ChangePassword verifies the current password and rotates it in one write
// transaction: the users row is locked and the committed hash and active
// status re-read inside the transaction, so a concurrent change that
// committed first makes this verification fail (exactly one concurrent
// change succeeds) and a disable that committed while this change waited
// on the lock fails the change with no partial write; on success the
// transaction stores the new hash, clears must_change_password, revokes
// every OTHER session of the user through the Session module's others
// disposition (the calling session survives — the contract's current-
// session carve-out), and writes the password_changed audit row. A wrong
// current password answers errInvalidCredentials exactly like login.
func (s *Service) ChangePassword(ctx context.Context, principal authz.Principal, req ChangePasswordRequest) (ChangePasswordResponse, error) {
	newHash, err := HashPassword(*req.NewPassword)
	if err != nil {
		// Validate already enforced the policy; a failure here is unreachable
		// through HTTP and still must not proceed unhashed.
		return ChangePasswordResponse{}, fmt.Errorf("auth: hash new password: %w", err)
	}
	// Input validation, not transactional work: a principal without its
	// user or session identity is a wiring bug, refused before the
	// transaction (the same seam Logout uses).
	others, err := session.Others(principal.UserID, principal.SessionID)
	if err != nil {
		return ChangePasswordResponse{}, err
	}

	err = s.runner.Run(ctx, func(sc *writetx.Scope) error {
		tx := sc.Tx()
		var storedHash string
		var owesInitialChange bool
		var status string
		if err := tx.QueryRow(ctx,
			`SELECT password_hash, must_change_password, status FROM public.users WHERE id = $1 FOR UPDATE`,
			principal.UserID,
		).Scan(&storedHash, &owesInitialChange, &status); err != nil {
			return fmt.Errorf("auth: load user for change-password: %w", err)
		}
		// The caller-owned lock is the recheck point: a disable committed
		// while this change waited must end the change here, before any
		// write, so the rolled-back attempt leaves nothing behind. The
		// answer is the command's uniform credential failure — the endpoint
		// documents no account-disabled shape, and the account's next
		// request is 401 at the guard regardless.
		if status != "active" {
			return errInvalidCredentials
		}
		if !verifyPassword(storedHash, *req.CurrentPassword) {
			return errInvalidCredentials
		}
		if _, err := tx.Exec(ctx,
			`UPDATE public.users
			 SET password_hash = $2, must_change_password = false, updated_at = now()
			 WHERE id = $1`,
			principal.UserID, newHash,
		); err != nil {
			return fmt.Errorf("auth: update password: %w", err)
		}
		// Revocation is the session module's one trusted step inside this
		// command's write transaction; the command decides its own audit.
		if _, err := s.sessions.Revoke(ctx, sc, others); err != nil {
			return err
		}
		actor, err := audit.SnapshotSubject(ctx, tx, principal.UserID)
		if err != nil {
			return err
		}
		metadata := map[string]string{}
		if owesInitialChange {
			metadata["initial"] = "true"
		}
		return audit.Write(ctx, tx, audit.Entry{
			Actor:    actor,
			Action:   audit.PasswordChanged,
			Metadata: metadata,
		})
	})
	if err != nil {
		return ChangePasswordResponse{}, err
	}
	return ChangePasswordResponse{Status: "password_changed"}, nil
}

// UpdateMeRequest is the PATCH /users/me body. Display name is the only
// self-service field today; login email stays an admin-only command.
type UpdateMeRequest struct {
	DisplayName *string `json:"display_name"`
}

// Validate checks the shape and the display-name rule: the raw value must
// fit the contract's maxLength (1–128 Unicode characters, counted like
// OpenAPI maxLength — never bytes) and must be non-empty after trimming;
// trimming normalizes storage but never rescues an over-length value.
func (r *UpdateMeRequest) Validate() *command.Error {
	if r.DisplayName == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with display_name."}
	}
	name := strings.TrimSpace(*r.DisplayName)
	if name == "" || utf8.RuneCountInString(*r.DisplayName) > maxDisplayNameLength {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_display_name", Message: "Display name must be 1 to 128 characters, and non-empty after trimming."}
	}
	return nil
}

// UpdateMe renames the caller's own account in one write transaction — the
// row is locked and the previous name read inside the transaction, so
// concurrent renames audit a truthful from→to chain — and records the
// display_name_changed audit row in the same transaction: renames change
// the name every later audit snapshot attributes, so the trail must be able
// to show who renamed what (ADR-0009). The audit actor snapshots the name
// this transaction commits.
func (s *Service) UpdateMe(ctx context.Context, principal authz.Principal, req UpdateMeRequest) (MeResponse, error) {
	name := strings.TrimSpace(*req.DisplayName)

	var updated userRecord
	err := s.runner.Run(ctx, func(sc *writetx.Scope) error {
		tx := sc.Tx()
		var previous string
		if err := tx.QueryRow(ctx,
			`SELECT display_name FROM public.users WHERE id = $1 FOR UPDATE`,
			principal.UserID,
		).Scan(&previous); err != nil {
			return fmt.Errorf("auth: load display name for update: %w", err)
		}
		if err := tx.QueryRow(ctx,
			`UPDATE public.users
			 SET display_name = $2, updated_at = now()
			 WHERE id = $1
			 RETURNING id, email, password_hash, display_name, role, status, must_change_password`,
			principal.UserID, name,
		).Scan(&updated.ID, &updated.Email, &updated.PasswordHash, &updated.DisplayName, &updated.Role, &updated.Status, &updated.MustChangePassword); err != nil {
			return fmt.Errorf("auth: update display name: %w", err)
		}
		actor, err := audit.SnapshotSubject(ctx, tx, principal.UserID)
		if err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.Entry{
			Actor:    actor,
			Action:   audit.DisplayNameChanged,
			Metadata: map[string]string{"from": previous, "to": name},
		})
	})
	if err != nil {
		return MeResponse{}, err
	}
	return MeResponse{User: userResponse(updated)}, nil
}
