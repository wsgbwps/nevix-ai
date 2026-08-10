// Package invitations owns the Identity Module's Invitation trusted commands.
package invitations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/authjwt"
	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/outbox"
	"github.com/nevix-ai/server/internal/identity/verification"
)

const invitationValidity = 7 * 24 * time.Hour

var (
	uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

	errInvalidOrganizationID = errors.New("invitations: invalid organization id")
	errInvalidInvitationID   = errors.New("invitations: invalid invitation id")
	errOrganizationNotFound  = errors.New("invitations: organization not found")
	errInvitationNotFound    = errors.New("invitations: invitation not found")
	errInsufficientRole      = errors.New("invitations: insufficient organization role")
	errActiveMembership      = errors.New("invitations: email already has active membership")
	errPendingInvitation     = errors.New("invitations: pending invitation already exists")
	errInvitationNotPending  = errors.New("invitations: invitation is not pending")
	errInvitationRevoked     = errors.New("invitations: invitation is revoked")
	errInvitationExpired     = errors.New("invitations: invitation is expired")
	errInvalidInvitationCode = errors.New("invitations: invalid invitation code")
	errCodeAttemptsExhausted = errors.New("invitations: invitation code attempts exhausted")
)

// Creator handles Invitation trusted commands with the deployment-scoped code
// HMAC key and sender reused from the existing verification-code capability.
type Creator struct {
	pool *pgxpool.Pool
	cfg  verification.CodeIssuanceConfig
}

func NewCreator(pool *pgxpool.Pool, cfg verification.CodeIssuanceConfig) *Creator {
	return &Creator{pool: pool, cfg: cfg}
}

// Invitation is the minimal Invitation representation returned by its commands.
type Invitation struct {
	ID             string    `json:"id"`
	OrganizationID string    `json:"organization_id"`
	Email          string    `json:"email"`
	Status         string    `json:"status"`
	ExpiresAt      time.Time `json:"expires_at"`
}

// InvitationResponse returns the affected Invitation without exposing the
// plaintext verification code.
type InvitationResponse struct {
	Invitation Invitation `json:"invitation"`
}

// CreateInvitationRequest is the CreateInvitation command input. The route
// adapter supplies OrganizationID and ClientIP rather than decoding them.
type CreateInvitationRequest struct {
	Email          *string `json:"email"`
	OrganizationID string  `json:"-"`
	ClientIP       string  `json:"-"`
}

func (r *CreateInvitationRequest) Validate() *command.Error {
	if r.Email == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with an email field."}
	}
	normalized, err := verification.NormalizeEmail(*r.Email)
	if err != nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_email", Message: "email must be a bare address like user@example.com."}
	}
	*r.Email = normalized
	return nil
}

// decodeJSONObject distinguishes a JSON object from null for commands whose
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

// MapError translates invitation-domain errors to the trusted-command contract.
func MapError(err error) *command.Error {
	if mapped := verification.MapError(err); mapped != nil {
		return mapped
	}
	switch {
	case errors.Is(err, errInvalidOrganizationID):
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_organization_id", Message: "organization_id must be a UUID."}
	case errors.Is(err, errInvalidInvitationID):
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_invitation_id", Message: "invitation_id must be a UUID."}
	case errors.Is(err, errOrganizationNotFound):
		return &command.Error{Status: http.StatusNotFound, Code: "organization_not_found", Message: "The organization was not found."}
	case errors.Is(err, errInvitationNotFound):
		return &command.Error{Status: http.StatusNotFound, Code: "invitation_not_found", Message: "The invitation was not found."}
	case errors.Is(err, errInsufficientRole):
		return &command.Error{Status: http.StatusForbidden, Code: "insufficient_organization_role", Message: "Owner or Admin role is required."}
	case errors.Is(err, errActiveMembership):
		return &command.Error{Status: http.StatusConflict, Code: "active_membership_exists", Message: "This email already belongs to an active member of the organization."}
	case errors.Is(err, errPendingInvitation):
		return &command.Error{Status: http.StatusConflict, Code: "pending_invitation_exists", Message: "A pending invitation already exists for this email."}
	case errors.Is(err, errInvitationNotPending):
		return &command.Error{Status: http.StatusConflict, Code: "invitation_not_pending", Message: "The invitation is no longer pending."}
	case errors.Is(err, errInvitationRevoked):
		return &command.Error{Status: http.StatusConflict, Code: "invitation_revoked", Message: "The invitation has been revoked."}
	case errors.Is(err, errInvitationExpired):
		return &command.Error{Status: http.StatusConflict, Code: "invitation_expired", Message: "The invitation has expired."}
	case errors.Is(err, errInvalidInvitationCode):
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_invitation_code", Message: "The invitation code is invalid."}
	case errors.Is(err, errCodeAttemptsExhausted):
		return &command.Error{Status: http.StatusConflict, Code: "code_attempts_exhausted", Message: "This invitation code has no attempts remaining."}
	default:
		return nil
	}
}

// CreateInvitation creates the pending Invitation, its seven-day code, its
// rendered email, and its immutable Audit Log row in one identity_app
// transaction. The pending partial unique index backs concurrent creates.
func (c *Creator) CreateInvitation(ctx context.Context, req CreateInvitationRequest) (InvitationResponse, error) {
	organizationID, err := normalizeOrganizationID(req.OrganizationID)
	if err != nil {
		return InvitationResponse{}, err
	}
	email := *req.Email

	tx, err := c.begin(ctx)
	if err != nil {
		return InvitationResponse{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	organizationName, actor, err := authorizeInvitationAdmin(ctx, tx, organizationID, authjwt.UserID(ctx))
	if err != nil {
		return InvitationResponse{}, err
	}
	if err := lockInvitationEmail(ctx, tx, organizationID, email); err != nil {
		return InvitationResponse{}, err
	}
	if err := rejectActiveMemberEmail(ctx, tx, organizationID, email); err != nil {
		return InvitationResponse{}, err
	}

	var invitation Invitation
	err = tx.QueryRow(ctx,
		`INSERT INTO public.invitations (organization_id, email, expires_at)
		 VALUES ($1, $2, clock_timestamp() + make_interval(secs => $3))
		 ON CONFLICT (organization_id, email) WHERE status = 'pending' DO NOTHING
		 RETURNING id, organization_id, email, status, expires_at`,
		organizationID, email, invitationValidity.Seconds(),
	).Scan(
		&invitation.ID,
		&invitation.OrganizationID,
		&invitation.Email,
		&invitation.Status,
		&invitation.ExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return InvitationResponse{}, errPendingInvitation
	}
	if err != nil {
		return InvitationResponse{}, fmt.Errorf("invitations: insert invitation: %w", err)
	}

	if err := verification.EnforceIssuanceLimits(ctx, tx, invitation.Email, req.ClientIP); err != nil {
		return InvitationResponse{}, err
	}
	if err := c.issueInvitationCode(ctx, tx, invitation, req.ClientIP, organizationName); err != nil {
		return InvitationResponse{}, err
	}
	if err := audit.Write(ctx, tx, audit.Entry{
		OrganizationID: organizationID,
		Actor:          actor,
		Action:         audit.InvitationCreated,
		Metadata: map[string]string{
			"invitation_id": invitation.ID,
			"email":         invitation.Email,
		},
	}); err != nil {
		return InvitationResponse{}, err
	}
	if err := tx.Commit(context.WithoutCancel(ctx)); err != nil {
		return InvitationResponse{}, fmt.Errorf("invitations: commit create: %w", err)
	}
	return InvitationResponse{Invitation: invitation}, nil
}

func (c *Creator) begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := c.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("invitations: begin command: %w", err)
	}
	if _, err := tx.Exec(ctx, "SET LOCAL ROLE identity_app"); err != nil {
		tx.Rollback(context.WithoutCancel(ctx))
		return nil, fmt.Errorf("invitations: switch to identity_app: %w", err)
	}
	return tx, nil
}

func normalizeOrganizationID(raw string) (string, error) {
	organizationID := strings.ToLower(strings.TrimSpace(raw))
	if !uuidPattern.MatchString(organizationID) {
		return "", errInvalidOrganizationID
	}
	return organizationID, nil
}

// authorizeInvitationAdmin locks the actor's active Membership before the
// command changes Organization state. A missing Membership intentionally maps
// to 404, while a Member role maps to the explicit 403 contract.
func authorizeInvitationAdmin(ctx context.Context, tx pgx.Tx, organizationID, userID string) (string, audit.Subject, error) {
	var role, organizationName string
	err := tx.QueryRow(ctx,
		`SELECT m.role, o.name
		 FROM public.memberships m
		 JOIN public.organizations o ON o.id = m.organization_id
		 WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'active'
		 FOR UPDATE OF m`,
		organizationID, userID,
	).Scan(&role, &organizationName)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", audit.Subject{}, errOrganizationNotFound
	}
	if err != nil {
		return "", audit.Subject{}, fmt.Errorf("invitations: read actor membership: %w", err)
	}
	if role != "owner" && role != "admin" {
		return "", audit.Subject{}, errInsufficientRole
	}
	actor, err := audit.SnapshotUser(ctx, tx, userID)
	if err != nil {
		return "", audit.Subject{}, err
	}
	return organizationName, actor, nil
}

// rejectActiveMemberEmail locks a matching active Membership when one exists.
// An ended Membership deliberately does not match and can receive a new invite.
func rejectActiveMemberEmail(ctx context.Context, tx pgx.Tx, organizationID, email string) error {
	var membershipID string
	err := tx.QueryRow(ctx,
		`SELECT m.id
		 FROM public.memberships m
		 JOIN identity.directory d ON d.id = m.user_id
		 WHERE m.organization_id = $1 AND m.status = 'active' AND lower(d.email) = $2
		 FOR UPDATE OF m`,
		organizationID, email,
	).Scan(&membershipID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("invitations: check active member email: %w", err)
	}
	return errActiveMembership
}

// lockInvitationEmail serializes Invitation creation and acceptance for one
// Organization/email pair before either command decides whether an active
// Membership exists.
func lockInvitationEmail(ctx context.Context, tx pgx.Tx, organizationID, email string) error {
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, organizationID, email,
	); err != nil {
		return fmt.Errorf("invitations: lock invitation email: %w", err)
	}
	return nil
}

func (c *Creator) issueInvitationCode(ctx context.Context, tx pgx.Tx, invitation Invitation, clientIP, organizationName string) error {
	var code, codeHash string
	for {
		nextCode, err := verification.NewSixDigitCode()
		if err != nil {
			return fmt.Errorf("invitations: generate code: %w", err)
		}
		code = nextCode
		codeHash = verification.HashCode(c.cfg.HashKey, code)
		used, err := invitationCodeHashExists(ctx, tx, invitation.ID, codeHash)
		if err != nil {
			return err
		}
		if !used {
			break
		}
	}
	var codeID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO identity.verification_codes (
			email, action_type, target_id, code_hash, request_ip, created_at, expires_at
		) VALUES ($1, 'invitation', $2, $3, $4, clock_timestamp(), $5)
		 RETURNING id`,
		invitation.Email,
		invitation.ID,
		codeHash,
		clientIP,
		invitation.ExpiresAt,
	).Scan(&codeID); err != nil {
		return fmt.Errorf("invitations: insert verification code: %w", err)
	}
	subject, body, err := outbox.RenderInvitation(outbox.InvitationTemplateData{
		OrganizationName: organizationName,
		Code:             code,
	})
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO identity.outbox_messages (sender, recipient, subject, body, verification_code_id)
		 VALUES ($1, $2, $3, $4, $5)`,
		c.cfg.From, invitation.Email, subject, body, codeID,
	); err != nil {
		return fmt.Errorf("invitations: queue invitation email: %w", err)
	}
	return nil
}

func invitationCodeHashExists(ctx context.Context, tx pgx.Tx, invitationID, codeHash string) (bool, error) {
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (
			SELECT 1
			FROM identity.verification_codes
			WHERE target_id = $1 AND action_type = 'invitation' AND code_hash = $2
		)`, invitationID, codeHash,
	).Scan(&exists); err != nil {
		return false, fmt.Errorf("invitations: check prior invitation code: %w", err)
	}
	return exists, nil
}
