// Package auditlog owns the shared transactional Audit Append seam
// (ADR-0009 2026-08-26 revision, ADR-0016): every appending Module appends
// actor/target snapshots, a legal action, and caller-sanitized metadata to
// the immutable audit log inside its own business transaction. Append
// receives that transaction and never owns its lifecycle: an append failure
// returns an error so the caller's outer transaction rolls back, and a
// commit makes the audit row and the caller's business facts visible
// together. Sanitization discipline stays with the caller; the Identity
// Module keeps the admin-only Audit Log read.
package auditlog

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Action is the application-owned Audit Log vocabulary shared by every
// appending Module. The schema deliberately keeps action as text, so new
// actions extend this list without a migration; this package is the single
// writer that validates the vocabulary (ADR-0009).
type Action string

const (
	// InstanceClaimed records the one-time Instance Claim: the request that
	// created the instance's first admin (and the session it entered the
	// application with); metadata records the claimed email and whether the
	// deployment demanded a setup code (issue #128, ADR-0015 2026-08-24
	// revision).
	InstanceClaimed Action = "instance_claimed"
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
	// JoinCodeCreated records an admin issuing a join code; the metadata
	// names the code row and carries the label the admin noted for it.
	JoinCodeCreated Action = "join_code_created"
	// JoinCodeRevoked records an admin revoking a join code; the metadata
	// names the code row whose registration window just closed.
	JoinCodeRevoked Action = "join_code_revoked"
	// UserSelfRegistered records a member redeeming an active join code for
	// their own account; the metadata names the email and the code redeemed,
	// and the session issued with it rides this same row (issue #121).
	UserSelfRegistered Action = "user_self_registered"
	// ReauthProofIssued records an admin passing current-password
	// reverification and receiving one exact-action Reauthentication Proof;
	// metadata names the bound action and never carries the password or the
	// token (issue #154, ADR-0016).
	ReauthProofIssued Action = "reauth_proof_issued"
	// ReauthProofConsumed records the single no-restore consumption of one
	// Reauthentication Proof; metadata names the action it authorized
	// (issue #154, ADR-0016).
	ReauthProofConsumed Action = "reauth_proof_consumed"
)

var validActions = map[Action]struct{}{
	InstanceClaimed:     {},
	SessionCreated:      {},
	SessionRevoked:      {},
	PasswordChanged:     {},
	DisplayNameChanged:  {},
	UserCreated:         {},
	UserDisabled:        {},
	UserPasswordReset:   {},
	UserEmailChanged:    {},
	UserRoleChanged:     {},
	UserDeleted:         {},
	JoinCodeCreated:     {},
	JoinCodeRevoked:     {},
	UserSelfRegistered:  {},
	ReauthProofIssued:   {},
	ReauthProofConsumed: {},
}

// Subject is a User identity snapshot stored in an Audit Log entry: user_id
// and display name exactly as they were at write time, deliberately without a
// foreign key so history survives later renames and deletions (ADR-0009).
// Subjects come from the single-tenant user registry, so an Audit Actor is
// always a real User — V1 models no system or operator actor.
type Subject struct {
	UserID      string
	DisplayName string
}

// Entry is one immutable Audit Log row. A nil Target records an action
// without a second User involved.
type Entry struct {
	Actor    Subject
	Target   *Subject
	Action   Action
	Metadata map[string]string
}

// SnapshotSubject reads the audit subject (id + display name) for one user
// from the single-tenant user registry inside the caller's write
// transaction, so audit rows record the display name committed at write time
// (ADR-0009). The shared snapshot seam for every audit-writing command.
func SnapshotSubject(ctx context.Context, tx pgx.Tx, userID string) (Subject, error) {
	var subject Subject
	if err := tx.QueryRow(ctx,
		`SELECT id, display_name FROM public.users WHERE id = $1`, userID,
	).Scan(&subject.UserID, &subject.DisplayName); err != nil {
		return Subject{}, fmt.Errorf("auditlog: snapshot subject: %w", err)
	}
	return subject, nil
}

// Append validates and inserts one immutable Audit Log row in the caller's
// transaction; the caller owns that transaction's commit and rollback, so an
// error returned here rolls the caller's business writes back with it.
// Database grants, not a trigger, enforce the no-UPDATE rule (ADR-0009).
func Append(ctx context.Context, tx pgx.Tx, entry Entry) error {
	if _, ok := validActions[entry.Action]; !ok {
		return fmt.Errorf("auditlog: unsupported action %q", entry.Action)
	}

	metadata := "{}"
	if entry.Metadata != nil {
		encoded, err := json.Marshal(entry.Metadata)
		if err != nil {
			return fmt.Errorf("auditlog: encode metadata: %w", err)
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
		return fmt.Errorf("auditlog: append entry: %w", err)
	}
	return nil
}
