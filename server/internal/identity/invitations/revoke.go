package invitations

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/authjwt"
	"github.com/nevix-ai/server/internal/identity/command"
)

// RevokeInvitationRequest is supplied by the route adapter; it has no JSON
// fields because revocation acts on the path-owned Invitation.
type RevokeInvitationRequest struct {
	jsonObject     bool
	OrganizationID string `json:"-"`
	InvitationID   string `json:"-"`
}

func (r *RevokeInvitationRequest) UnmarshalJSON(data []byte) error {
	isObject, err := decodeJSONObject(data)
	if err != nil {
		return err
	}
	r.jsonObject = isObject
	return nil
}

func (r *RevokeInvitationRequest) Validate() *command.Error {
	return validateJSONObject(r.jsonObject)
}

// RevokeInvitation revokes a pending Invitation and atomically cancels any
// still-undelivered code email. Repeating a completed revocation returns the
// same resource without adding another Audit Log row.
func (c *Creator) RevokeInvitation(ctx context.Context, req RevokeInvitationRequest) (InvitationResponse, error) {
	organizationID, err := normalizeOrganizationID(req.OrganizationID)
	if err != nil {
		return InvitationResponse{}, err
	}
	invitationID, err := normalizeInvitationID(req.InvitationID)
	if err != nil {
		return InvitationResponse{}, err
	}

	var invitation Invitation
	err = c.tx.Run(ctx, func(tx pgx.Tx) error {
		_, actor, err := authorizeInvitationAdmin(ctx, tx, organizationID, authjwt.UserID(ctx))
		if err != nil {
			return err
		}
		invitation, err = lockInvitation(ctx, tx, organizationID, invitationID)
		if err != nil {
			return err
		}
		if invitation.Status == "revoked" {
			// Repeating a completed revocation returns the same resource without
			// adding another Audit Log row.
			return nil
		}
		if invitation.Status != "pending" {
			return errInvitationNotPending
		}

		if _, err := tx.Exec(ctx,
			`UPDATE public.invitations SET status = 'revoked', updated_at = now() WHERE id = $1`, invitation.ID,
		); err != nil {
			return fmt.Errorf("invitations: revoke invitation: %w", err)
		}
		if err := supersedeActiveInvitationCodes(ctx, tx, invitation.ID); err != nil {
			return err
		}
		if err := cancelPendingInvitationOutbox(ctx, tx, invitation.ID); err != nil {
			return err
		}
		if err := audit.Write(ctx, tx, audit.Entry{
			OrganizationID: organizationID,
			Actor:          actor,
			Action:         audit.InvitationRevoked,
			Metadata: map[string]string{
				"invitation_id": invitation.ID,
				"email":         invitation.Email,
			},
		}); err != nil {
			return err
		}
		invitation.Status = "revoked"
		return nil
	})
	if err != nil {
		return InvitationResponse{}, err
	}
	return InvitationResponse{Invitation: invitation}, nil
}

func normalizeInvitationID(raw string) (string, error) {
	invitationID := strings.ToLower(strings.TrimSpace(raw))
	if !uuidPattern.MatchString(invitationID) {
		return "", errInvalidInvitationID
	}
	return invitationID, nil
}

func lockInvitation(ctx context.Context, tx pgx.Tx, organizationID, invitationID string) (Invitation, error) {
	var invitation Invitation
	if err := tx.QueryRow(ctx,
		`SELECT id, organization_id, email, status, expires_at
		 FROM public.invitations
		 WHERE id = $1 AND organization_id = $2
		 FOR UPDATE`,
		invitationID, organizationID,
	).Scan(
		&invitation.ID,
		&invitation.OrganizationID,
		&invitation.Email,
		&invitation.Status,
		&invitation.ExpiresAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Invitation{}, errInvitationNotFound
		}
		return Invitation{}, fmt.Errorf("invitations: lock invitation: %w", err)
	}
	return invitation, nil
}

func supersedeActiveInvitationCodes(ctx context.Context, tx pgx.Tx, invitationID string) error {
	if _, err := tx.Exec(ctx,
		`UPDATE identity.verification_codes
		 SET status = 'superseded', superseded_at = now()
		 WHERE target_id = $1 AND action_type = 'invitation' AND status = 'active'`, invitationID,
	); err != nil {
		return fmt.Errorf("invitations: supersede invitation code: %w", err)
	}
	return nil
}

func cancelPendingInvitationOutbox(ctx context.Context, tx pgx.Tx, invitationID string) error {
	if _, err := tx.Exec(ctx,
		`UPDATE identity.outbox_messages AS outbox
		 SET status = 'cancelled'
		 FROM identity.verification_codes AS code
		 WHERE outbox.verification_code_id = code.id
		   AND code.target_id = $1
		   AND code.action_type = 'invitation'
		   AND outbox.status = 'pending'`, invitationID,
	); err != nil {
		return fmt.Errorf("invitations: cancel invitation outbox: %w", err)
	}
	return nil
}
