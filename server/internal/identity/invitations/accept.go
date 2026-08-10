package invitations

import (
	"context"
	"crypto/hmac"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/nevix-ai/server/internal/identity/audit"
	"github.com/nevix-ai/server/internal/identity/authjwt"
	"github.com/nevix-ai/server/internal/identity/command"
	"github.com/nevix-ai/server/internal/identity/verification"
)

const invitationCodeAttemptLimit = 5

// Membership is the minimal active Membership representation returned when an
// invitee joins an Organization.
type Membership struct {
	ID             string `json:"id"`
	OrganizationID string `json:"organization_id"`
	UserID         string `json:"user_id"`
	Role           string `json:"role"`
	Status         string `json:"status"`
}

// AcceptInvitationResponse returns the active Membership created by acceptance.
type AcceptInvitationResponse struct {
	Membership Membership `json:"membership"`
}

// AcceptInvitationRequest carries the six-digit code. The route adapter owns
// InvitationID because it is not client-supplied JSON.
type AcceptInvitationRequest struct {
	Code         *string `json:"code"`
	InvitationID string  `json:"-"`
}

func (r *AcceptInvitationRequest) Validate() *command.Error {
	if r.Code == nil {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Request body must be JSON with a code field."}
	}
	if len(*r.Code) != 6 {
		return &command.Error{Status: http.StatusBadRequest, Code: "invalid_invitation_code", Message: "code must contain exactly six digits."}
	}
	for _, digit := range *r.Code {
		if digit < '0' || digit > '9' {
			return &command.Error{Status: http.StatusBadRequest, Code: "invalid_invitation_code", Message: "code must contain exactly six digits."}
		}
	}
	return nil
}

// AcceptInvitation validates a matching invitee's code, creates the active
// Member Membership, accepts the Invitation, snapshots the audit event, and
// consumes the code in a single transaction. Wrong code attempts commit their
// counter update before returning the command error.
func (c *Creator) AcceptInvitation(ctx context.Context, req AcceptInvitationRequest) (AcceptInvitationResponse, error) {
	invitationID, err := normalizeInvitationID(req.InvitationID)
	if err != nil {
		return AcceptInvitationResponse{}, err
	}

	tx, err := c.begin(ctx)
	if err != nil {
		return AcceptInvitationResponse{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	userID := authjwt.UserID(ctx)
	userEmail, err := invitationUserEmail(ctx, tx, userID)
	if err != nil {
		return AcceptInvitationResponse{}, err
	}
	organizationID, err := invitationOrganizationID(ctx, tx, invitationID)
	if err != nil {
		return AcceptInvitationResponse{}, err
	}
	if err := lockInvitationEmail(ctx, tx, organizationID, userEmail); err != nil {
		return AcceptInvitationResponse{}, err
	}
	invitation, err := lockInvitationForAcceptance(ctx, tx, invitationID)
	if err != nil {
		return AcceptInvitationResponse{}, err
	}
	if userEmail != invitation.Email {
		return AcceptInvitationResponse{}, errInvitationNotFound
	}

	if invitation.Status == "accepted" {
		membership, err := activeMembershipForInvitee(ctx, tx, invitation.OrganizationID, userID)
		if err != nil {
			return AcceptInvitationResponse{}, err
		}
		return AcceptInvitationResponse{Membership: membership}, nil
	}
	if invitation.Status == "revoked" {
		return AcceptInvitationResponse{}, errInvitationRevoked
	}
	if invitation.Status != "pending" {
		return AcceptInvitationResponse{}, errInvitationNotPending
	}
	code, err := lockLatestInvitationCode(ctx, tx, invitation.ID)
	if err != nil {
		return AcceptInvitationResponse{}, err
	}
	currentTime, err := databaseCurrentTime(ctx, tx)
	if err != nil {
		return AcceptInvitationResponse{}, err
	}
	if !invitation.ExpiresAt.After(currentTime) || !code.ExpiresAt.After(currentTime) {
		return AcceptInvitationResponse{}, errInvitationExpired
	}
	if code.Status != "active" {
		if code.FailedAttempts >= invitationCodeAttemptLimit {
			return AcceptInvitationResponse{}, errCodeAttemptsExhausted
		}
		return AcceptInvitationResponse{}, errInvalidInvitationCode
	}
	if !hmac.Equal([]byte(code.Hash), []byte(verification.HashCode(c.cfg.HashKey, *req.Code))) {
		commandErr, err := c.recordFailedInvitationCode(ctx, tx, invitation.ID, code)
		if err != nil {
			return AcceptInvitationResponse{}, err
		}
		if err := tx.Commit(context.WithoutCancel(ctx)); err != nil {
			return AcceptInvitationResponse{}, fmt.Errorf("invitations: commit failed code attempt: %w", err)
		}
		return AcceptInvitationResponse{}, commandErr
	}

	membership, err := insertActiveMember(ctx, tx, invitation.OrganizationID, userID)
	if err != nil {
		return AcceptInvitationResponse{}, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE public.invitations SET status = 'accepted', updated_at = now() WHERE id = $1`, invitation.ID,
	); err != nil {
		return AcceptInvitationResponse{}, fmt.Errorf("invitations: accept invitation: %w", err)
	}
	actor, err := audit.SnapshotUser(ctx, tx, userID)
	if err != nil {
		return AcceptInvitationResponse{}, err
	}
	if err := audit.Write(ctx, tx, audit.Entry{
		OrganizationID: invitation.OrganizationID,
		Actor:          actor,
		Target:         &actor,
		Action:         audit.InvitationAccepted,
		Metadata: map[string]string{
			"invitation_id": invitation.ID,
			"email":         invitation.Email,
		},
	}); err != nil {
		return AcceptInvitationResponse{}, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE identity.verification_codes SET status = 'consumed' WHERE id = $1`, code.ID,
	); err != nil {
		return AcceptInvitationResponse{}, fmt.Errorf("invitations: consume invitation code: %w", err)
	}
	if err := tx.Commit(context.WithoutCancel(ctx)); err != nil {
		return AcceptInvitationResponse{}, fmt.Errorf("invitations: commit acceptance: %w", err)
	}
	return AcceptInvitationResponse{Membership: membership}, nil
}

type invitationCode struct {
	ID             string
	Hash           string
	Status         string
	ExpiresAt      time.Time
	FailedAttempts int
}

func invitationUserEmail(ctx context.Context, tx pgx.Tx, userID string) (string, error) {
	var email string
	if err := tx.QueryRow(ctx, `SELECT lower(email) FROM identity.directory WHERE id = $1`, userID).Scan(&email); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", errInvitationNotFound
		}
		return "", fmt.Errorf("invitations: read invitee email: %w", err)
	}
	return strings.ToLower(email), nil
}

// invitationOrganizationID obtains the stable subject key before acceptance
// takes its advisory lock; the subsequent FOR UPDATE read remains the state
// authority for acceptance.
func invitationOrganizationID(ctx context.Context, tx pgx.Tx, invitationID string) (string, error) {
	var organizationID string
	if err := tx.QueryRow(ctx,
		`SELECT organization_id FROM public.invitations WHERE id = $1`, invitationID,
	).Scan(&organizationID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", errInvitationNotFound
		}
		return "", fmt.Errorf("invitations: read invitation organization: %w", err)
	}
	return organizationID, nil
}

func lockInvitationForAcceptance(ctx context.Context, tx pgx.Tx, invitationID string) (Invitation, error) {
	var invitation Invitation
	if err := tx.QueryRow(ctx,
		`SELECT id, organization_id, email, status, expires_at
		 FROM public.invitations
		 WHERE id = $1
		 FOR UPDATE`, invitationID,
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
		return Invitation{}, fmt.Errorf("invitations: lock invitation for acceptance: %w", err)
	}
	return invitation, nil
}

func lockLatestInvitationCode(ctx context.Context, tx pgx.Tx, invitationID string) (invitationCode, error) {
	var code invitationCode
	if err := tx.QueryRow(ctx,
		`SELECT id, code_hash, status, expires_at, failed_attempts
		 FROM identity.verification_codes
		 WHERE target_id = $1 AND action_type = 'invitation'
		 -- A waiting resend can commit after a later-started resend, so its active
		 -- code may have an earlier transaction timestamp than a superseded row.
		 ORDER BY (status = 'active') DESC, created_at DESC
		 LIMIT 1
		 FOR UPDATE`, invitationID,
	).Scan(&code.ID, &code.Hash, &code.Status, &code.ExpiresAt, &code.FailedAttempts); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return invitationCode{}, errInvalidInvitationCode
		}
		return invitationCode{}, fmt.Errorf("invitations: lock invitation code: %w", err)
	}
	return code, nil
}

// databaseCurrentTime keeps expiry decisions on the database clock that wrote
// invitation and verification-code deadlines. clock_timestamp advances while a
// command waits on row or advisory locks, unlike transaction-scoped now().
func databaseCurrentTime(ctx context.Context, tx pgx.Tx) (time.Time, error) {
	var currentTime time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&currentTime); err != nil {
		return time.Time{}, fmt.Errorf("invitations: read database time: %w", err)
	}
	return currentTime, nil
}

func (c *Creator) recordFailedInvitationCode(ctx context.Context, tx pgx.Tx, invitationID string, code invitationCode) (error, error) {
	attempts := code.FailedAttempts + 1
	if attempts >= invitationCodeAttemptLimit {
		if _, err := tx.Exec(ctx,
			`UPDATE identity.verification_codes
			 SET failed_attempts = $2, status = 'superseded', superseded_at = now()
			 WHERE id = $1`, code.ID, attempts,
		); err != nil {
			return nil, fmt.Errorf("invitations: exhaust invitation code attempts: %w", err)
		}
		if err := cancelPendingInvitationOutbox(ctx, tx, invitationID); err != nil {
			return nil, err
		}
		return errCodeAttemptsExhausted, nil
	}
	if _, err := tx.Exec(ctx,
		`UPDATE identity.verification_codes SET failed_attempts = $2 WHERE id = $1`, code.ID, attempts,
	); err != nil {
		return nil, fmt.Errorf("invitations: record failed invitation code attempt: %w", err)
	}
	return errInvalidInvitationCode, nil
}

func insertActiveMember(ctx context.Context, tx pgx.Tx, organizationID, userID string) (Membership, error) {
	var membership Membership
	if err := tx.QueryRow(ctx,
		`INSERT INTO public.memberships (organization_id, user_id, role, status)
		 VALUES ($1, $2, 'member', 'active')
		 ON CONFLICT (organization_id, user_id) WHERE status = 'active' DO NOTHING
		 RETURNING id, organization_id, user_id, role, status`, organizationID, userID,
	).Scan(
		&membership.ID,
		&membership.OrganizationID,
		&membership.UserID,
		&membership.Role,
		&membership.Status,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Membership{}, errActiveMembership
		}
		return Membership{}, fmt.Errorf("invitations: create member membership: %w", err)
	}
	return membership, nil
}

func activeMembershipForInvitee(ctx context.Context, tx pgx.Tx, organizationID, userID string) (Membership, error) {
	var membership Membership
	if err := tx.QueryRow(ctx,
		`SELECT id, organization_id, user_id, role, status
		 FROM public.memberships
		 WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`, organizationID, userID,
	).Scan(
		&membership.ID,
		&membership.OrganizationID,
		&membership.UserID,
		&membership.Role,
		&membership.Status,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Membership{}, errInvitationNotFound
		}
		return Membership{}, fmt.Errorf("invitations: read accepted membership: %w", err)
	}
	return membership, nil
}
