// Package audit owns the Identity Audit Log: immutable transactional writes
// (commands construct entries from transaction-time user snapshots; this
// package validates the action vocabulary and persists the row without
// exposing a mutation seam to callers outside the identity Module) and the
// admin-only paginated read. Rows carry no organization dimension
// (ADR-0009 revision) and are immutable by grant, not by trigger.
package audit

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Action is an application-owned Audit Log vocabulary. The schema deliberately
// keeps action as text, so new actions extend this list without a migration.
type Action string

const (
	// BootstrapAdminCreated records the environment-driven creation of the
	// first admin on an empty deployment (ADR-0015 bootstrap).
	BootstrapAdminCreated Action = "bootstrap_admin_created"
	// SessionCreated records a successful login issuing an opaque session.
	SessionCreated Action = "session_created"
	// SessionRevoked records a logout ending exactly one session.
	SessionRevoked Action = "session_revoked"
	// PasswordChanged records a user rotating their own password (the
	// first-login forced change and everyday self-service rotation alike).
	PasswordChanged Action = "password_changed"
	// DisplayNameChanged records a user renaming their own account: renames
	// change the name later audit snapshots attribute, so the trail records
	// who renamed what.
	DisplayNameChanged Action = "display_name_changed"
	// UserCreated records an admin creating an account with an initial
	// password (must_change_password rides the account row).
	UserCreated Action = "user_created"
	// UserDisabled records an admin deactivating an account; the same
	// transaction revoked every one of its sessions.
	UserDisabled Action = "user_disabled"
	// UserPasswordReset records an admin resetting an account's password to
	// a new initial password; the same transaction revoked its sessions.
	UserPasswordReset Action = "user_password_reset"
	// UserEmailChanged records an admin changing an account's login email.
	UserEmailChanged Action = "user_email_changed"
	// UserRoleChanged records an admin switching an account between member
	// and admin.
	UserRoleChanged Action = "user_role_changed"
	// UserDeleted records an admin deleting an account that never logged in.
	UserDeleted Action = "user_deleted"
)

var validActions = map[Action]struct{}{
	BootstrapAdminCreated: {},
	SessionCreated:        {},
	SessionRevoked:        {},
	PasswordChanged:       {},
	DisplayNameChanged:    {},
	UserCreated:           {},
	UserDisabled:          {},
	UserPasswordReset:     {},
	UserEmailChanged:      {},
	UserRoleChanged:       {},
	UserDeleted:           {},
}

// Subject is a User identity snapshot stored in an Audit Log entry: user_id
// and display name exactly as they were at write time, deliberately without a
// foreign key so history survives later renames and deletions (ADR-0009).
type Subject struct {
	UserID      string
	DisplayName string
}

// Entry is one immutable Audit Log row. A nil Target records an action without
// a second User involved.
type Entry struct {
	Actor    Subject
	Target   *Subject
	Action   Action
	Metadata map[string]string
}

// SnapshotSubject reads the audit subject (id + display name) for one user
// inside the caller's write transaction, so audit rows record the display
// name committed at write time (ADR-0009). The shared snapshot seam for every
// audit-writing command.
func SnapshotSubject(ctx context.Context, tx pgx.Tx, userID string) (Subject, error) {
	var subject Subject
	if err := tx.QueryRow(ctx,
		`SELECT id, display_name FROM public.users WHERE id = $1`, userID,
	).Scan(&subject.UserID, &subject.DisplayName); err != nil {
		return Subject{}, fmt.Errorf("identity audit: snapshot subject: %w", err)
	}
	return subject, nil
}

// Write validates and inserts one immutable Audit Log row in the caller's
// transaction. Database grants, not a trigger, enforce the no-UPDATE rule.
func Write(ctx context.Context, tx pgx.Tx, entry Entry) error {
	if _, ok := validActions[entry.Action]; !ok {
		return fmt.Errorf("identity audit: unsupported action %q", entry.Action)
	}

	metadata := "{}"
	if entry.Metadata != nil {
		encoded, err := json.Marshal(entry.Metadata)
		if err != nil {
			return fmt.Errorf("identity audit: encode metadata: %w", err)
		}
		metadata = string(encoded)
	}

	var targetUserID, targetDisplayName any
	if entry.Target != nil {
		targetUserID = entry.Target.UserID
		targetDisplayName = entry.Target.DisplayName
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO public.audit_logs (
			actor_user_id, actor_display_name,
			target_user_id, target_display_name, action, metadata
		) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
		entry.Actor.UserID,
		entry.Actor.DisplayName,
		targetUserID,
		targetDisplayName,
		entry.Action,
		metadata,
	); err != nil {
		return fmt.Errorf("identity audit: insert entry: %w", err)
	}
	return nil
}
