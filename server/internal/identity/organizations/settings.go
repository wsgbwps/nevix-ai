package organizations

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/authjwt"
	"github.com/nevix-ai/server/internal/identity/command"
)

// UpdateOrganizationSettingsRequest carries the editable Organization name;
// the route adapter supplies the Organization identifier.
type UpdateOrganizationSettingsRequest struct {
	Name           *string `json:"name"`
	OrganizationID string  `json:"-"`
}

func (r *UpdateOrganizationSettingsRequest) Validate() *command.Error {
	if r.Name == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with a name field."}
	}
	*r.Name = strings.TrimSpace(*r.Name)
	if *r.Name == "" {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_organization_name", Message: "name must not be blank."}
	}
	return nil
}

// UpdateOrganizationSettings lets the active Owner change the Organization
// name. The name change and its immutable audit entry commit together;
// settings changes intentionally enqueue no email.
func (m *Manager) UpdateOrganizationSettings(ctx context.Context, req UpdateOrganizationSettingsRequest) (OrganizationResponse, error) {
	organizationID, err := normalizeOrganizationID(req.OrganizationID)
	if err != nil {
		return OrganizationResponse{}, err
	}

	tx, err := m.begin(ctx)
	if err != nil {
		return OrganizationResponse{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	role, err := lockOrganizationActor(ctx, tx, organizationID, authjwt.UserID(ctx))
	if err != nil {
		return OrganizationResponse{}, err
	}
	if role != "owner" {
		return OrganizationResponse{}, errInsufficientRole
	}
	actor, err := audit.SnapshotUser(ctx, tx, authjwt.UserID(ctx))
	if err != nil {
		return OrganizationResponse{}, err
	}

	var response OrganizationResponse
	if err := tx.QueryRow(ctx,
		`UPDATE public.organizations
		 SET name = $1, updated_at = now()
		 WHERE id = $2
		 RETURNING id, name`,
		*req.Name, organizationID,
	).Scan(&response.Organization.ID, &response.Organization.Name); err != nil {
		return OrganizationResponse{}, fmt.Errorf("organizations: update settings: %w", err)
	}
	if err := audit.Write(ctx, tx, audit.Entry{
		OrganizationID: organizationID,
		Actor:          actor,
		Action:         audit.OrganizationSettingsUpdated,
	}); err != nil {
		return OrganizationResponse{}, err
	}
	if err := tx.Commit(context.WithoutCancel(ctx)); err != nil {
		return OrganizationResponse{}, fmt.Errorf("organizations: commit settings update: %w", err)
	}
	return response, nil
}

func lockOrganizationActor(ctx context.Context, tx pgx.Tx, organizationID, userID string) (string, error) {
	var role string
	if err := tx.QueryRow(ctx,
		`SELECT m.role
		 FROM public.memberships AS m
		 JOIN public.organizations AS o ON o.id = m.organization_id
		 WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'active'
		 FOR UPDATE OF m, o`,
		organizationID, userID,
	).Scan(&role); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", errOrganizationNotFound
		}
		return "", fmt.Errorf("organizations: lock settings actor: %w", err)
	}
	return role, nil
}
