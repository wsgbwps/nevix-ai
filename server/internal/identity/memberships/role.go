package memberships

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/authjwt"
	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/outbox"
)

type membershipRoleAction string

const (
	promoteMember membershipRoleAction = "promote"
	demoteAdmin   membershipRoleAction = "demote"
	removeAdmin   membershipRoleAction = "remove"
)

type membershipRoleActionDescriptor struct {
	sourceRole         string
	sourceRoleError    error
	updateSQL          string
	auditAction        audit.Action
	renderNotification func(outbox.AdminRoleTemplateData) (string, string, error)
}

var membershipRoleActions = map[membershipRoleAction]membershipRoleActionDescriptor{
	promoteMember: {
		sourceRole:         "member",
		sourceRoleError:    errTargetNotMember,
		updateSQL:          `UPDATE public.memberships SET role = 'admin', updated_at = now() WHERE id = $1`,
		auditAction:        audit.AdminPromoted,
		renderNotification: outbox.RenderAdminPromoted,
	},
	demoteAdmin: {
		sourceRole:         "admin",
		sourceRoleError:    errTargetNotAdmin,
		updateSQL:          `UPDATE public.memberships SET role = 'member', updated_at = now() WHERE id = $1`,
		auditAction:        audit.AdminDemoted,
		renderNotification: outbox.RenderAdminDemoted,
	},
	removeAdmin: {
		sourceRole:         "admin",
		sourceRoleError:    errTargetNotAdmin,
		updateSQL:          `UPDATE public.memberships SET status = 'ended', updated_at = now() WHERE id = $1`,
		auditAction:        audit.AdminRemoved,
		renderNotification: outbox.RenderAdminRemoved,
	},
}

// ChangeMemberRoleRequest carries the explicit Admin lifecycle operation. The
// Organization and target Membership remain route-owned.
type ChangeMemberRoleRequest struct {
	Action         *string `json:"action"`
	OrganizationID string  `json:"-"`
	MembershipID   string  `json:"-"`
}

func (r *ChangeMemberRoleRequest) Validate() *command.Error {
	if r.Action == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with an action field."}
	}
	*r.Action = strings.ToLower(strings.TrimSpace(*r.Action))
	if _, ok := membershipRoleActions[membershipRoleAction(*r.Action)]; !ok {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_role_action", Message: "action must be promote, demote, or remove."}
	}
	return nil
}

// ChangeMemberRole gives the active Owner the three explicit Admin lifecycle
// operations. It never changes an Owner Membership, so the transaction keeps
// the exactly-one-active-Owner invariant intact.
func (m *Manager) ChangeMemberRole(ctx context.Context, req ChangeMemberRoleRequest) (MembershipResponse, error) {
	organizationID, err := normalizeOrganizationID(req.OrganizationID)
	if err != nil {
		return MembershipResponse{}, err
	}
	membershipID, err := normalizeMembershipID(req.MembershipID)
	if err != nil {
		return MembershipResponse{}, err
	}
	action := membershipRoleAction(*req.Action)
	descriptor, ok := membershipRoleActions[action]
	if !ok {
		return MembershipResponse{}, errInvalidRoleAction
	}

	tx, err := m.begin(ctx)
	if err != nil {
		return MembershipResponse{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	actorMembership, targetMembership, organizationName, err := lockActorAndTargetMembership(ctx, tx, organizationID, authjwt.UserID(ctx), membershipID)
	if err != nil {
		return MembershipResponse{}, err
	}
	if actorMembership.Role != "owner" {
		return MembershipResponse{}, errOwnerRoleRequired
	}
	if targetMembership.Role != descriptor.sourceRole {
		return MembershipResponse{}, descriptor.sourceRoleError
	}
	actor, err := audit.SnapshotUser(ctx, tx, actorMembership.UserID)
	if err != nil {
		return MembershipResponse{}, err
	}
	target, err := audit.SnapshotUser(ctx, tx, targetMembership.UserID)
	if err != nil {
		return MembershipResponse{}, err
	}

	if err := applyAdminRoleAction(ctx, tx, action, descriptor, &targetMembership); err != nil {
		return MembershipResponse{}, err
	}
	if err := audit.Write(ctx, tx, audit.Entry{
		OrganizationID: organizationID,
		Actor:          actor,
		Target:         &target,
		Action:         descriptor.auditAction,
	}); err != nil {
		return MembershipResponse{}, err
	}
	if err := m.queueAdminRoleNotifications(ctx, tx, action, descriptor, organizationID, organizationName, actor, target); err != nil {
		return MembershipResponse{}, err
	}
	if err := tx.Commit(context.WithoutCancel(ctx)); err != nil {
		return MembershipResponse{}, fmt.Errorf("memberships: commit change member role: %w", err)
	}
	return MembershipResponse{Membership: targetMembership}, nil
}

func applyAdminRoleAction(ctx context.Context, tx pgx.Tx, action membershipRoleAction, descriptor membershipRoleActionDescriptor, membership *Membership) error {
	if err := tx.QueryRow(ctx,
		descriptor.updateSQL+` RETURNING id, organization_id, user_id, role, status`, membership.ID,
	).Scan(
		&membership.ID,
		&membership.OrganizationID,
		&membership.UserID,
		&membership.Role,
		&membership.Status,
	); err != nil {
		return fmt.Errorf("memberships: apply %s action: %w", action, err)
	}
	return nil
}

func (m *Manager) queueAdminRoleNotifications(ctx context.Context, tx pgx.Tx, action membershipRoleAction, descriptor membershipRoleActionDescriptor, organizationID, organizationName string, actor, target audit.Subject) error {
	targetRecipient, err := memberEmail(ctx, tx, target.UserID)
	if err != nil {
		return err
	}
	ownerRecipient, err := activeOwnerEmail(ctx, tx, organizationID)
	if err != nil {
		return err
	}
	for _, recipient := range []struct {
		email string
		name  string
	}{
		{email: targetRecipient, name: target.DisplayName},
		{email: ownerRecipient, name: actor.DisplayName},
	} {
		subject, body, err := descriptor.renderNotification(outbox.AdminRoleTemplateData{
			OrganizationName: organizationName,
			ActorName:        actor.DisplayName,
			AffectedName:     target.DisplayName,
			RecipientName:    recipient.name,
		})
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO identity.outbox_messages (sender, recipient, subject, body)
			 VALUES ($1, $2, $3, $4)`,
			m.sender, recipient.email, subject, body,
		); err != nil {
			return fmt.Errorf("memberships: queue %s notification: %w", action, err)
		}
	}
	return nil
}

func activeOwnerEmail(ctx context.Context, tx pgx.Tx, organizationID string) (string, error) {
	var email string
	if err := tx.QueryRow(ctx,
		`SELECT lower(d.email)
		 FROM public.memberships AS m
		 JOIN identity.directory AS d ON d.id = m.user_id
		 WHERE m.organization_id = $1 AND m.role = 'owner' AND m.status = 'active'`,
		organizationID,
	).Scan(&email); err != nil {
		return "", fmt.Errorf("memberships: read active owner email: %w", err)
	}
	return email, nil
}
