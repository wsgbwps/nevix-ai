package invitations

import (
	"context"
	"fmt"

	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/authjwt"
	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/verification"
)

// ResendInvitationRequest is supplied by the route adapter; ClientIP is used
// only for the new, code-carrying Outbox delivery record.
type ResendInvitationRequest struct {
	jsonObject     bool
	OrganizationID string `json:"-"`
	InvitationID   string `json:"-"`
	ClientIP       string `json:"-"`
}

func (r *ResendInvitationRequest) UnmarshalJSON(data []byte) error {
	isObject, err := decodeJSONObject(data)
	if err != nil {
		return err
	}
	r.jsonObject = isObject
	return nil
}

func (r *ResendInvitationRequest) Validate() *command.Error {
	return validateJSONObject(r.jsonObject)
}

// ResendInvitation keeps a pending Invitation, gives it a fresh seven-day
// deadline, and atomically replaces its code-carrying delivery with a new one.
func (c *Creator) ResendInvitation(ctx context.Context, req ResendInvitationRequest) (InvitationResponse, error) {
	organizationID, err := normalizeOrganizationID(req.OrganizationID)
	if err != nil {
		return InvitationResponse{}, err
	}
	invitationID, err := normalizeInvitationID(req.InvitationID)
	if err != nil {
		return InvitationResponse{}, err
	}

	tx, err := c.begin(ctx)
	if err != nil {
		return InvitationResponse{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	organizationName, actor, err := authorizeInvitationAdmin(ctx, tx, organizationID, authjwt.UserID(ctx))
	if err != nil {
		return InvitationResponse{}, err
	}
	invitation, err := lockInvitation(ctx, tx, organizationID, invitationID)
	if err != nil {
		return InvitationResponse{}, err
	}
	if invitation.Status != "pending" {
		return InvitationResponse{}, errInvitationNotPending
	}

	if err := verification.EnforceIssuanceLimits(ctx, tx, invitation.Email, req.ClientIP); err != nil {
		return InvitationResponse{}, err
	}
	if err := cancelPendingInvitationOutbox(ctx, tx, invitation.ID); err != nil {
		return InvitationResponse{}, err
	}
	if err := supersedeActiveInvitationCodes(ctx, tx, invitation.ID); err != nil {
		return InvitationResponse{}, err
	}
	if err := tx.QueryRow(ctx,
		`UPDATE public.invitations
		 SET expires_at = clock_timestamp() + make_interval(secs => $2),
		     organization_name = $3,
		     inviter_display_name = $4,
		     updated_at = now()
		 WHERE id = $1
		 RETURNING expires_at`, invitation.ID, invitationValidity.Seconds(),
		organizationName, actor.DisplayName,
	).Scan(&invitation.ExpiresAt); err != nil {
		return InvitationResponse{}, fmt.Errorf("invitations: refresh invitation expiration: %w", err)
	}
	if err := c.issueInvitationCode(ctx, tx, invitation, req.ClientIP, organizationName); err != nil {
		return InvitationResponse{}, err
	}
	if err := audit.Write(ctx, tx, audit.Entry{
		OrganizationID: organizationID,
		Actor:          actor,
		Action:         audit.InvitationResent,
		Metadata: map[string]string{
			"invitation_id": invitation.ID,
			"email":         invitation.Email,
		},
	}); err != nil {
		return InvitationResponse{}, err
	}
	if err := tx.Commit(context.WithoutCancel(ctx)); err != nil {
		return InvitationResponse{}, fmt.Errorf("invitations: commit resend: %w", err)
	}
	return InvitationResponse{Invitation: invitation}, nil
}
