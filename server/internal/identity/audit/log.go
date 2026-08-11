// Package audit owns immutable Identity Audit Log writes. Commands construct
// entries from transaction-time profile snapshots; this package validates the
// action vocabulary and persists the row without exposing a mutation seam to
// callers outside the identity Module.
package audit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Action is an application-owned Audit Log vocabulary. The schema deliberately
// keeps action as text, so new actions extend this list without a migration.
type Action string

const (
	InvitationCreated  Action = "invitation_created"
	InvitationResent   Action = "invitation_resent"
	InvitationRevoked  Action = "invitation_revoked"
	InvitationAccepted Action = "invitation_accepted"
)

var validActions = map[Action]struct{}{
	InvitationCreated:  {},
	InvitationResent:   {},
	InvitationRevoked:  {},
	InvitationAccepted: {},
}

// Subject is a User identity snapshot stored in an Audit Log entry.
type Subject struct {
	UserID      string
	DisplayName string
}

// Entry is one immutable Audit Log row. A nil Target records an action without
// a User target, such as an invitation sent to an email address.
type Entry struct {
	OrganizationID string
	Actor          Subject
	Target         *Subject
	Action         Action
	Metadata       map[string]string
}

var ErrProfileNotFound = errors.New("identity audit: profile not found")

// SnapshotUser records the Profile display name inside the caller's command
// transaction. A User who has not completed Profile setup is identified by the
// verified directory email instead, so an otherwise valid trusted command
// never loses its immutable audit event to an internal error.
func SnapshotUser(ctx context.Context, tx pgx.Tx, userID string) (Subject, error) {
	subject := Subject{UserID: userID}
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(p.display_name, d.email)
		 FROM identity.directory AS d
		 LEFT JOIN public.profiles AS p ON p.user_id = d.id
		 WHERE d.id = $1`, userID,
	).Scan(&subject.DisplayName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Subject{}, ErrProfileNotFound
		}
		return Subject{}, fmt.Errorf("identity audit: read user snapshot: %w", err)
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
			organization_id, actor_user_id, actor_display_name,
			target_user_id, target_display_name, action, metadata
		) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
		entry.OrganizationID,
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
