// Package audit owns immutable Identity Audit Log writes. Commands construct
// entries from transaction-time user snapshots; this package validates the
// action vocabulary and persists the row without exposing a mutation seam to
// callers outside the identity Module. Rows carry no organization dimension
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
)

var validActions = map[Action]struct{}{
	BootstrapAdminCreated: {},
	SessionCreated:        {},
	SessionRevoked:        {},
	PasswordChanged:       {},
	DisplayNameChanged:    {},
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
