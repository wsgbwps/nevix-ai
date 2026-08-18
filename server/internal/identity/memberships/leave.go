// Package memberships owns the Identity Module's Membership trusted commands.
package memberships

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/authjwt"
	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/writetx"
)

var (
	uuidPattern              = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	errInvalidOrganizationID = errors.New("memberships: invalid organization id")
	errInvalidMembershipID   = errors.New("memberships: invalid membership id")
	errOrganizationNotFound  = errors.New("memberships: organization not found")
	errOwnerCannotLeave      = errors.New("memberships: owner cannot leave")
	errOwnerRoleRequired     = errors.New("memberships: owner role required")
	errInsufficientRole      = errors.New("memberships: insufficient organization role")
	errMembershipNotFound    = errors.New("memberships: membership not found")
	errTargetNotMember       = errors.New("memberships: target is not a member")
	errTargetNotAdmin        = errors.New("memberships: target is not an admin")
	errInvalidRoleAction     = errors.New("memberships: invalid role action")
)

// Manager handles Membership trusted commands through the identity_app
// write-transaction runner.
type Manager struct {
	tx     *writetx.Runner
	sender string
}

func NewManager(tx *writetx.Runner, sender string) *Manager {
	return &Manager{tx: tx, sender: sender}
}

// Membership is the minimal Membership representation returned by its commands.
type Membership struct {
	ID             string `json:"id"`
	OrganizationID string `json:"organization_id"`
	UserID         string `json:"user_id"`
	Role           string `json:"role"`
	Status         string `json:"status"`
}

// MembershipResponse returns the affected Membership.
type MembershipResponse struct {
	Membership Membership `json:"membership"`
}

// LeaveOrganizationRequest is intentionally empty: the Organization belongs to
// the route and the caller belongs to the verified Bearer JWT.
type LeaveOrganizationRequest struct {
	OrganizationID string `json:"-"`
	isObject       bool
}

func (r *LeaveOrganizationRequest) UnmarshalJSON(data []byte) error {
	isObject, err := decodeJSONObject(data)
	if err != nil {
		return err
	}
	r.isObject = isObject
	return nil
}

func (r *LeaveOrganizationRequest) Validate() *command.Error {
	return validateJSONObject(r.isObject)
}

// MapError translates Membership-domain errors to the trusted-command contract.
func MapError(err error) *command.Error {
	switch {
	case errors.Is(err, errInvalidOrganizationID):
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_organization_id", Message: "organization_id must be a UUID."}
	case errors.Is(err, errInvalidMembershipID):
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_membership_id", Message: "membership_id must be a UUID."}
	case errors.Is(err, errOrganizationNotFound):
		return &command.Error{Status: http.StatusNotFound, Code: "organization_not_found", Message: "The organization was not found."}
	case errors.Is(err, errMembershipNotFound):
		return &command.Error{Status: http.StatusNotFound, Code: "membership_not_found", Message: "The active membership was not found."}
	case errors.Is(err, errOwnerRoleRequired):
		return &command.Error{Status: http.StatusForbidden, Code: "insufficient_organization_role", Message: "Owner role is required."}
	case errors.Is(err, errInsufficientRole):
		return &command.Error{Status: http.StatusForbidden, Code: "insufficient_organization_role", Message: "Owner or Admin role is required."}
	case errors.Is(err, errOwnerCannotLeave):
		return &command.Error{Status: http.StatusConflict, Code: "owner_cannot_leave", Message: "Transfer ownership before leaving the organization."}
	case errors.Is(err, errTargetNotMember):
		return &command.Error{Status: http.StatusConflict, Code: "membership_not_member", Message: "The target must be an active Member."}
	case errors.Is(err, errTargetNotAdmin):
		return &command.Error{Status: http.StatusConflict, Code: "membership_not_admin", Message: "The target must be an active Admin."}
	case errors.Is(err, errInvalidRoleAction):
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_role_action", Message: "action must be promote, demote, or remove."}
	default:
		return nil
	}
}

// LeaveOrganization ends the caller's active Member or Admin Membership and
// snapshots the exit in the same identity_app transaction. An Owner must first
// transfer ownership, preserving the exactly-one-active-Owner invariant.
func (m *Manager) LeaveOrganization(ctx context.Context, req LeaveOrganizationRequest) (MembershipResponse, error) {
	organizationID, err := normalizeOrganizationID(req.OrganizationID)
	if err != nil {
		return MembershipResponse{}, err
	}

	var membership Membership
	err = m.tx.Run(ctx, func(tx pgx.Tx) error {
		var actor audit.Subject
		membership, actor, err = lockCallerMembership(ctx, tx, organizationID, authjwt.UserID(ctx))
		if err != nil {
			return err
		}
		if membership.Role == "owner" {
			return errOwnerCannotLeave
		}
		if err := tx.QueryRow(ctx,
			`UPDATE public.memberships
			 SET status = 'ended', updated_at = now()
			 WHERE id = $1
			 RETURNING id, organization_id, user_id, role, status`, membership.ID,
		).Scan(
			&membership.ID,
			&membership.OrganizationID,
			&membership.UserID,
			&membership.Role,
			&membership.Status,
		); err != nil {
			return fmt.Errorf("memberships: end membership: %w", err)
		}
		if err := audit.Write(ctx, tx, audit.Entry{
			OrganizationID: organizationID,
			Actor:          actor,
			Action:         audit.MembershipLeft,
		}); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return MembershipResponse{}, err
	}
	return MembershipResponse{Membership: membership}, nil
}

func normalizeOrganizationID(raw string) (string, error) {
	organizationID := strings.ToLower(strings.TrimSpace(raw))
	if !uuidPattern.MatchString(organizationID) {
		return "", errInvalidOrganizationID
	}
	return organizationID, nil
}

func normalizeMembershipID(raw string) (string, error) {
	membershipID := strings.ToLower(strings.TrimSpace(raw))
	if !uuidPattern.MatchString(membershipID) {
		return "", errInvalidMembershipID
	}
	return membershipID, nil
}

// decodeJSONObject distinguishes an object from null for commands whose
// input is wholly route-owned. Arrays and scalar values remain decoder errors.
func decodeJSONObject(data []byte) (bool, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		return false, err
	}
	return object != nil, nil
}

func validateJSONObject(isObject bool) *command.Error {
	if !isObject {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be a JSON object."}
	}
	return nil
}

func lockCallerMembership(ctx context.Context, tx pgx.Tx, organizationID, userID string) (Membership, audit.Subject, error) {
	var membership Membership
	err := tx.QueryRow(ctx,
		`SELECT id, organization_id, user_id, role, status
		 FROM public.memberships
		 WHERE organization_id = $1 AND user_id = $2 AND status = 'active'
		 FOR UPDATE`,
		organizationID, userID,
	).Scan(
		&membership.ID,
		&membership.OrganizationID,
		&membership.UserID,
		&membership.Role,
		&membership.Status,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Membership{}, audit.Subject{}, errOrganizationNotFound
	}
	if err != nil {
		return Membership{}, audit.Subject{}, fmt.Errorf("memberships: lock caller membership: %w", err)
	}
	actor, err := audit.SnapshotUser(ctx, tx, userID)
	if err != nil {
		return Membership{}, audit.Subject{}, err
	}
	return membership, actor, nil
}
