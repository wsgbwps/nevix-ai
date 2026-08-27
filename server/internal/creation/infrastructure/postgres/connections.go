package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// ConnectionRepository persists the instance's single AI Provider
// Connection. The active row is addressed set-wise; the partial unique
// singleton index is the durable backstop under concurrent creates.
type ConnectionRepository struct {
	pool *pgxpool.Pool
}

func NewConnectionRepository(pool *pgxpool.Pool) *ConnectionRepository {
	return &ConnectionRepository{pool: pool}
}

const connectionColumns = `id, admin_state, credential_state, image_capability, video_capability,
	envelope_version, credential_key_id, credential_nonce, credential_ciphertext,
	last_checked_at, last_check_outcome, created_by_user_id, created_at, updated_at, terminated_at`

// Insert persists the first active connection inside the caller's write
// transaction. A concurrent winner on the singleton index surfaces
// ErrConnectionExists so both racers get one stable outcome.
func (r *ConnectionRepository) Insert(ctx context.Context, tx domain.TxExecutor, c *domain.ProviderConnection) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO provider_connections (
			id, admin_state, credential_state, image_capability, video_capability,
			envelope_version, credential_key_id, credential_nonce, credential_ciphertext,
			last_checked_at, last_check_outcome, created_by_user_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		c.ID, string(c.AdminState), string(c.CredentialState), string(c.ImageCapability), string(c.VideoCapability),
		c.Envelope.Version, c.Envelope.KeyID, c.Envelope.Nonce, c.Envelope.Ciphertext,
		c.LastCheckedAt, checkOutcomeValue(c.LastCheckOutcome), c.CreatedByUserID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return domain.ErrConnectionExists
		}
		return fmt.Errorf("creation: insert provider connection: %w", err)
	}
	return nil
}

// GetActive resolves the single active connection; absence is the stable
// ErrConnectionNotConfigured.
func (r *ConnectionRepository) GetActive(ctx context.Context) (domain.ProviderConnection, error) {
	row := r.pool.QueryRow(ctx,
		`SELECT `+connectionColumns+` FROM provider_connections WHERE terminated_at IS NULL`)
	return scanConnection(row)
}

// ReplaceCredential atomically switches envelope and states in the caller's
// transaction; the old ciphertext is overwritten only on commit.
func (r *ConnectionRepository) ReplaceCredential(ctx context.Context, tx domain.TxExecutor, id domain.UUID, envelope *domain.ProviderCredentialEnvelope, credentialState domain.CredentialState, image, video domain.MediaCapability, checkedAt time.Time, outcome domain.CheckOutcome) error {
	return r.updateActive(ctx, tx, `
		UPDATE provider_connections SET
			envelope_version = $2, credential_key_id = $3, credential_nonce = $4, credential_ciphertext = $5,
			credential_state = $6, image_capability = $7, video_capability = $8,
			last_checked_at = $9, last_check_outcome = $10, updated_at = now()
		WHERE id = $1 AND terminated_at IS NULL`,
		id, envelope.Version, envelope.KeyID, envelope.Nonce, envelope.Ciphertext,
		string(credentialState), string(image), string(video), checkedAt, string(outcome))
}

// SetCheckResult persists a recheck's verdicts without touching the envelope.
func (r *ConnectionRepository) SetCheckResult(ctx context.Context, tx domain.TxExecutor, id domain.UUID, credentialState domain.CredentialState, image, video domain.MediaCapability, checkedAt time.Time, outcome domain.CheckOutcome) error {
	return r.updateActive(ctx, tx, `
		UPDATE provider_connections SET
			credential_state = $2, image_capability = $3, video_capability = $4,
			last_checked_at = $5, last_check_outcome = $6, updated_at = now()
		WHERE id = $1 AND terminated_at IS NULL`,
		id, string(credentialState), string(image), string(video), checkedAt, string(outcome))
}

// MarkCredentialUnavailable fails the connection closed with both media
// unavailable (master key or envelope failure).
func (r *ConnectionRepository) MarkCredentialUnavailable(ctx context.Context, tx domain.TxExecutor, id domain.UUID) error {
	return r.updateActive(ctx, tx, `
		UPDATE provider_connections SET
			credential_state = $2, image_capability = $3, video_capability = $4, updated_at = now()
		WHERE id = $1 AND terminated_at IS NULL`,
		id, string(domain.CredentialStateCredentialUnavailable),
		string(domain.MediaCapabilityUnavailable), string(domain.MediaCapabilityUnavailable))
}

// updateActive executes one update and requires it to have addressed the
// active row; zero rows raced with termination and surface not-configured.
func (r *ConnectionRepository) updateActive(ctx context.Context, tx domain.TxExecutor, sql string, args ...any) error {
	tag, err := tx.Exec(ctx, sql, args...)
	if err != nil {
		return fmt.Errorf("creation: update provider connection: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrConnectionNotConfigured
	}
	return nil
}

// SetAdminState flips enabled/paused and returns the updated aggregate.
func (r *ConnectionRepository) SetAdminState(ctx context.Context, tx domain.TxExecutor, id domain.UUID, state domain.AdminState) (domain.ProviderConnection, error) {
	return scanConnection(tx.QueryRow(ctx, `
		UPDATE provider_connections SET admin_state = $2, updated_at = now()
		WHERE id = $1 AND terminated_at IS NULL
		RETURNING `+connectionColumns,
		id, string(state)))
}

// Terminate clears the envelope columns and stamps terminated_at; the
// non-sensitive identity row is retained for traceability.
func (r *ConnectionRepository) Terminate(ctx context.Context, tx domain.TxExecutor, id domain.UUID) error {
	return r.updateActive(ctx, tx, `
		UPDATE provider_connections SET
			envelope_version = NULL, credential_key_id = NULL, credential_nonce = NULL, credential_ciphertext = NULL,
			terminated_at = now(), updated_at = now()
		WHERE id = $1 AND terminated_at IS NULL`,
		id)
}

// scanConnection decodes the canonical column list into the aggregate; row
// absence is the stable not-configured outcome.
func scanConnection(row pgx.Row) (domain.ProviderConnection, error) {
	var c domain.ProviderConnection
	var adminState, credentialState, imageCapability, videoCapability string
	var envelopeVersion *int
	var keyID *string
	var nonce, ciphertext []byte
	var lastCheckOutcome *string
	if err := row.Scan(
		&c.ID, &adminState, &credentialState, &imageCapability, &videoCapability,
		&envelopeVersion, &keyID, &nonce, &ciphertext,
		&c.LastCheckedAt, &lastCheckOutcome,
		&c.CreatedByUserID, &c.CreatedAt, &c.UpdatedAt, &c.TerminatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ProviderConnection{}, domain.ErrConnectionNotConfigured
		}
		return domain.ProviderConnection{}, fmt.Errorf("creation: scan provider connection: %w", err)
	}
	c.AdminState = domain.AdminState(adminState)
	c.CredentialState = domain.CredentialState(credentialState)
	c.ImageCapability = domain.MediaCapability(imageCapability)
	c.VideoCapability = domain.MediaCapability(videoCapability)
	if lastCheckOutcome != nil {
		outcome := domain.CheckOutcome(*lastCheckOutcome)
		c.LastCheckOutcome = &outcome
	}
	// Envelope presence invariant: an active row always carries all four
	// envelope columns (database CHECK); a terminated row carries none.
	if envelopeVersion != nil && keyID != nil {
		c.Envelope = &domain.ProviderCredentialEnvelope{
			Version:    *envelopeVersion,
			KeyID:      *keyID,
			Nonce:      nonce,
			Ciphertext: ciphertext,
		}
	}
	return c, nil
}

// checkOutcomeValue renders a nullable outcome for insert.
func checkOutcomeValue(outcome *domain.CheckOutcome) any {
	if outcome == nil {
		return nil
	}
	return string(*outcome)
}
