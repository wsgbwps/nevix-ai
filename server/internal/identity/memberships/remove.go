package memberships

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/authjwt"
	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/outbox"
)

// RemoveMemberRequest is intentionally empty: both the Organization and
// affected Membership belong to the route, and the actor belongs to the
// verified Bearer JWT.
type RemoveMemberRequest struct {
	OrganizationID string `json:"-"`
	MembershipID   string `json:"-"`
	isObject       bool
}

func (r *RemoveMemberRequest) UnmarshalJSON(data []byte) error {
	isObject, err := decodeJSONObject(data)
	if err != nil {
		return err
	}
	r.isObject = isObject
	return nil
}

func (r *RemoveMemberRequest) Validate() *command.Error {
	return validateJSONObject(r.isObject)
}

// RemoveMember ends an active ordinary Member's Membership. Owner and Admin
// actors may remove Members, never an Owner or Admin, and the state change,
// audit entry, and codeless notification share one identity_app transaction.
func (m *Manager) RemoveMember(ctx context.Context, req RemoveMemberRequest) (MembershipResponse, error) {
	organizationID, err := normalizeOrganizationID(req.OrganizationID)
	if err != nil {
		return MembershipResponse{}, err
	}
	membershipID, err := normalizeMembershipID(req.MembershipID)
	if err != nil {
		return MembershipResponse{}, err
	}

	var targetMembership Membership
	err = m.tx.Run(ctx, func(tx pgx.Tx) error {
		actorMembership, lockedTarget, organizationName, err := lockActorAndTargetMembership(ctx, tx, organizationID, authjwt.UserID(ctx), membershipID)
		if err != nil {
			return err
		}
		if actorMembership.Role != "owner" && actorMembership.Role != "admin" {
			return errInsufficientRole
		}
		if lockedTarget.Role != "member" {
			return errTargetNotMember
		}
		actor, err := audit.SnapshotUser(ctx, tx, actorMembership.UserID)
		if err != nil {
			return err
		}
		target, err := audit.SnapshotUser(ctx, tx, lockedTarget.UserID)
		if err != nil {
			return err
		}

		if err := tx.QueryRow(ctx,
			`UPDATE public.memberships
			 SET status = 'ended', updated_at = now()
			 WHERE id = $1
			 RETURNING id, organization_id, user_id, role, status`, lockedTarget.ID,
		).Scan(
			&targetMembership.ID,
			&targetMembership.OrganizationID,
			&targetMembership.UserID,
			&targetMembership.Role,
			&targetMembership.Status,
		); err != nil {
			return fmt.Errorf("memberships: remove member: %w", err)
		}
		if err := audit.Write(ctx, tx, audit.Entry{
			OrganizationID: organizationID,
			Actor:          actor,
			Target:         &target,
			Action:         audit.MemberRemoved,
		}); err != nil {
			return err
		}
		if err := m.queueMemberRemoval(ctx, tx, organizationName, actor, target); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return MembershipResponse{}, err
	}
	return MembershipResponse{Membership: targetMembership}, nil
}

// lockActorAndTargetMembership locks the two active rows in UUID order before
// mutation. The deterministic order keeps role-changing commands from
// forming a wait cycle if their actors or targets overlap.
func lockActorAndTargetMembership(ctx context.Context, tx pgx.Tx, organizationID, actorUserID, targetMembershipID string) (Membership, Membership, string, error) {
	rows, err := tx.Query(ctx,
		`SELECT m.id, m.organization_id, m.user_id, m.role, m.status, o.name
		 FROM public.memberships AS m
		 JOIN public.organizations AS o ON o.id = m.organization_id
		 WHERE m.organization_id = $1
		   AND m.status = 'active'
		   AND (m.user_id = $2 OR m.id = $3)
		 ORDER BY m.id
		 FOR UPDATE OF m`,
		organizationID, actorUserID, targetMembershipID,
	)
	if err != nil {
		return Membership{}, Membership{}, "", fmt.Errorf("memberships: lock actor and target memberships: %w", err)
	}
	defer rows.Close()

	var actor, target Membership
	var organizationName string
	var foundActor, foundTarget bool
	for rows.Next() {
		var membership Membership
		if err := rows.Scan(
			&membership.ID,
			&membership.OrganizationID,
			&membership.UserID,
			&membership.Role,
			&membership.Status,
			&organizationName,
		); err != nil {
			return Membership{}, Membership{}, "", fmt.Errorf("memberships: scan actor or target membership: %w", err)
		}
		if membership.UserID == actorUserID {
			actor = membership
			foundActor = true
		}
		if membership.ID == targetMembershipID {
			target = membership
			foundTarget = true
		}
	}
	if err := rows.Err(); err != nil {
		return Membership{}, Membership{}, "", fmt.Errorf("memberships: iterate actor and target memberships: %w", err)
	}
	if !foundActor {
		return Membership{}, Membership{}, "", errOrganizationNotFound
	}
	if !foundTarget {
		return Membership{}, Membership{}, "", errMembershipNotFound
	}
	return actor, target, organizationName, nil
}

func (m *Manager) queueMemberRemoval(ctx context.Context, tx pgx.Tx, organizationName string, actor, target audit.Subject) error {
	recipient, err := memberEmail(ctx, tx, target.UserID)
	if err != nil {
		return err
	}
	subject, body, err := outbox.RenderMemberRemoved(outbox.MemberRemovedTemplateData{
		OrganizationName: organizationName,
		ActorName:        actor.DisplayName,
		AffectedName:     target.DisplayName,
	})
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO identity.outbox_messages (sender, recipient, subject, body)
		 VALUES ($1, $2, $3, $4)`,
		m.sender, recipient, subject, body,
	); err != nil {
		return fmt.Errorf("memberships: queue member removal email: %w", err)
	}
	return nil
}

func memberEmail(ctx context.Context, tx pgx.Tx, userID string) (string, error) {
	var email string
	if err := tx.QueryRow(ctx, `SELECT lower(email) FROM identity.directory WHERE id = $1`, userID).Scan(&email); err != nil {
		return "", fmt.Errorf("memberships: read membership email: %w", err)
	}
	return email, nil
}
