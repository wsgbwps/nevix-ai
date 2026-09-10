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

type ObjectStorageConnectionRepository struct {
	pool *pgxpool.Pool
}

func NewObjectStorageConnectionRepository(pool *pgxpool.Pool) *ObjectStorageConnectionRepository {
	return &ObjectStorageConnectionRepository{pool: pool}
}

const objectStorageConnectionColumns = `id, provider, region, bucket, revision, state,
	envelope_version, credential_key_id, credential_nonce, credential_ciphertext,
	access_key_id_masked, last_checked_at, last_check_outcome,
	created_by_user_id, created_at, updated_at, terminated_at, location_frozen_at`

func (r *ObjectStorageConnectionRepository) Insert(ctx context.Context, tx domain.TxExecutor, connection *domain.ObjectStorageConnection) error {
	err := scanObjectStorageConnection(tx.QueryRow(ctx, `
		INSERT INTO object_storage_connections (
			id, provider, region, bucket, state,
			envelope_version, credential_key_id, credential_nonce, credential_ciphertext,
			access_key_id_masked, last_checked_at, last_check_outcome, created_by_user_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		RETURNING `+objectStorageConnectionColumns,
		connection.ID, connection.Provider, connection.Region, connection.Bucket, connection.State,
		connection.Envelope.Version, connection.Envelope.KeyID, connection.Envelope.Nonce, connection.Envelope.Ciphertext,
		connection.AccessKeyIDMasked, connection.LastCheckedAt, connection.LastCheckOutcome, connection.CreatedByUserID,
	), connection)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.ConstraintName == "object_storage_connections_singleton_idx" {
			return domain.ErrObjectStorageConnectionExists
		}
		return fmt.Errorf("creation: insert object storage connection: %w", err)
	}
	return nil
}

func (r *ObjectStorageConnectionRepository) GetActive(ctx context.Context) (domain.ObjectStorageConnection, error) {
	var connection domain.ObjectStorageConnection
	err := scanObjectStorageConnection(r.pool.QueryRow(ctx,
		`SELECT `+objectStorageConnectionColumns+` FROM object_storage_connections WHERE terminated_at IS NULL`), &connection)
	return connection, err
}

func (r *ObjectStorageConnectionRepository) UpdateObservation(ctx context.Context, tx domain.TxExecutor, id domain.UUID, expectedRevision int64, checkedAt time.Time, outcome domain.CheckOutcome) error {
	tag, err := tx.Exec(ctx, `
		UPDATE object_storage_connections
		SET last_checked_at = $3, last_check_outcome = $4, updated_at = now()
		WHERE id = $1 AND revision = $2 AND state = 'ready' AND terminated_at IS NULL`,
		id, expectedRevision, checkedAt, outcome)
	if err != nil {
		return fmt.Errorf("creation: update object storage observation: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return r.classifyCASFailure(ctx, tx, expectedRevision, false, domain.ObjectStorageStateReady)
	}
	return nil
}

func (r *ObjectStorageConnectionRepository) ReplaceLocation(ctx context.Context, tx domain.TxExecutor, connection *domain.ObjectStorageConnection, expectedRevision int64) error {
	if err := r.lockLocationMutation(ctx, tx, connection.ID, expectedRevision, domain.ObjectStorageStateReady); err != nil {
		return err
	}
	err := scanObjectStorageConnection(tx.QueryRow(ctx, `
		UPDATE object_storage_connections SET
			provider = $3, region = $4, bucket = $5,
			revision = nextval('object_storage_connection_revision_seq'::regclass), state = 'ready',
			envelope_version = $6, credential_key_id = $7, credential_nonce = $8, credential_ciphertext = $9,
			access_key_id_masked = $10, last_checked_at = $11, last_check_outcome = $12, updated_at = now()
		WHERE id = $1 AND revision = $2 AND state = 'ready'
			AND terminated_at IS NULL AND location_frozen_at IS NULL
		RETURNING `+objectStorageConnectionColumns,
		connection.ID, expectedRevision, connection.Provider, connection.Region, connection.Bucket,
		connection.Envelope.Version, connection.Envelope.KeyID, connection.Envelope.Nonce, connection.Envelope.Ciphertext,
		connection.AccessKeyIDMasked, connection.LastCheckedAt, connection.LastCheckOutcome,
	), connection)
	if errors.Is(err, domain.ErrObjectStorageConnectionNotConfigured) {
		return r.classifyCASFailure(ctx, tx, expectedRevision, true, domain.ObjectStorageStateReady)
	}
	return err
}

func (r *ObjectStorageConnectionRepository) RotateCredential(ctx context.Context, tx domain.TxExecutor, connection *domain.ObjectStorageConnection, expectedRevision int64) error {
	return r.replaceCredential(ctx, tx, connection, expectedRevision, domain.ObjectStorageStateReady)
}

func (r *ObjectStorageConnectionRepository) RecoverCredential(ctx context.Context, tx domain.TxExecutor, connection *domain.ObjectStorageConnection, expectedRevision int64) error {
	return r.replaceCredential(ctx, tx, connection, expectedRevision, domain.ObjectStorageStateCredentialUnavailable)
}

func (r *ObjectStorageConnectionRepository) replaceCredential(ctx context.Context, tx domain.TxExecutor, connection *domain.ObjectStorageConnection, expectedRevision int64, requiredState domain.ObjectStorageState) error {
	err := scanObjectStorageConnection(tx.QueryRow(ctx, `
		UPDATE object_storage_connections SET
			revision = nextval('object_storage_connection_revision_seq'::regclass), state = 'ready',
			envelope_version = $4, credential_key_id = $5, credential_nonce = $6, credential_ciphertext = $7,
			access_key_id_masked = $8, last_checked_at = $9, last_check_outcome = $10, updated_at = now()
		WHERE id = $1 AND revision = $2 AND state = $3 AND terminated_at IS NULL
		RETURNING `+objectStorageConnectionColumns,
		connection.ID, expectedRevision, requiredState,
		connection.Envelope.Version, connection.Envelope.KeyID, connection.Envelope.Nonce, connection.Envelope.Ciphertext,
		connection.AccessKeyIDMasked, connection.LastCheckedAt, connection.LastCheckOutcome,
	), connection)
	if errors.Is(err, domain.ErrObjectStorageConnectionNotConfigured) {
		return r.classifyCASFailure(ctx, tx, expectedRevision, false, requiredState)
	}
	return err
}

func (r *ObjectStorageConnectionRepository) Terminate(ctx context.Context, tx domain.TxExecutor, id domain.UUID, expectedRevision int64) error {
	if err := r.lockLocationMutation(ctx, tx, id, expectedRevision, ""); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE object_storage_connections SET
			envelope_version = NULL, credential_key_id = NULL,
			credential_nonce = NULL, credential_ciphertext = NULL,
			terminated_at = now(), updated_at = now()
		WHERE id = $1 AND revision = $2 AND terminated_at IS NULL AND location_frozen_at IS NULL`,
		id, expectedRevision)
	if err != nil {
		return fmt.Errorf("creation: terminate object storage connection: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return r.classifyCASFailure(ctx, tx, expectedRevision, true, "")
	}
	return nil
}

func (r *ObjectStorageConnectionRepository) lockLocationMutation(ctx context.Context, tx domain.TxExecutor, id domain.UUID, expectedRevision int64, requiredState domain.ObjectStorageState) error {
	var revision int64
	var state string
	var frozenAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT revision, state, location_frozen_at
		FROM object_storage_connections
		WHERE id = $1 AND terminated_at IS NULL
		FOR UPDATE`, id).Scan(&revision, &state, &frozenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrObjectStorageConnectionNotConfigured
	}
	if err != nil {
		return fmt.Errorf("creation: lock object storage location: %w", err)
	}
	if revision != expectedRevision {
		return domain.ErrObjectStorageRevisionConflict
	}
	if frozenAt != nil {
		return domain.ErrObjectStorageLocationFrozen
	}
	if requiredState == domain.ObjectStorageStateReady && state == string(domain.ObjectStorageStateCredentialUnavailable) {
		return domain.ErrObjectStorageRecoveryRequired
	}
	var unresolvedUpload bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM creation_reference_material_uploads
			WHERE (status IN ('pending', 'verifying')
			   OR (cleanup_next_attempt_at IS NOT NULL AND cleanup_confirmed_at IS NULL))
		)`).Scan(&unresolvedUpload); err != nil {
		return fmt.Errorf("creation: inspect unresolved reference material uploads: %w", err)
	}
	if unresolvedUpload {
		return domain.ErrObjectStorageLocationFrozen
	}
	return nil
}

func (r *ObjectStorageConnectionRepository) MarkCredentialUnavailable(ctx context.Context, tx domain.TxExecutor, id domain.UUID, expectedRevision int64) (bool, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE object_storage_connections
		SET state = 'credential_unavailable', updated_at = now()
		WHERE id = $1 AND revision = $2 AND state <> 'credential_unavailable' AND terminated_at IS NULL`, id, expectedRevision)
	if err != nil {
		return false, fmt.Errorf("creation: mark object storage credential unavailable: %w", err)
	}
	if tag.RowsAffected() == 1 {
		return true, nil
	}
	var revision int64
	var state string
	err = tx.QueryRow(ctx, `SELECT revision, state FROM object_storage_connections WHERE id = $1 AND terminated_at IS NULL`, id).Scan(&revision, &state)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("creation: inspect object storage credential state: %w", err)
	}
	return revision == expectedRevision && state == string(domain.ObjectStorageStateCredentialUnavailable), nil
}

func (r *ObjectStorageConnectionRepository) classifyCASFailure(ctx context.Context, tx domain.TxExecutor, expectedRevision int64, requireUnfrozen bool, requiredState domain.ObjectStorageState) error {
	var revision int64
	var state string
	var frozenAt *time.Time
	err := tx.QueryRow(ctx, `
		SELECT revision, state, location_frozen_at
		FROM object_storage_connections WHERE terminated_at IS NULL`).Scan(&revision, &state, &frozenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrObjectStorageConnectionNotConfigured
	}
	if err != nil {
		return fmt.Errorf("creation: inspect object storage connection CAS: %w", err)
	}
	if revision != expectedRevision {
		return domain.ErrObjectStorageRevisionConflict
	}
	if requireUnfrozen && frozenAt != nil {
		return domain.ErrObjectStorageLocationFrozen
	}
	if requiredState == domain.ObjectStorageStateReady && state == string(domain.ObjectStorageStateCredentialUnavailable) {
		return domain.ErrObjectStorageRecoveryRequired
	}
	if requiredState == domain.ObjectStorageStateCredentialUnavailable && state != string(requiredState) {
		return domain.ErrObjectStorageRecoveryNotRequired
	}
	return domain.ErrObjectStorageRevisionConflict
}

func scanObjectStorageConnection(row pgx.Row, connection *domain.ObjectStorageConnection) error {
	var provider, state string
	var envelope domain.ObjectStorageCredentialEnvelope
	if err := row.Scan(
		&connection.ID, &provider, &connection.Region, &connection.Bucket, &connection.Revision, &state,
		&envelope.Version, &envelope.KeyID, &envelope.Nonce, &envelope.Ciphertext,
		&connection.AccessKeyIDMasked, &connection.LastCheckedAt, &connection.LastCheckOutcome,
		&connection.CreatedByUserID, &connection.CreatedAt, &connection.UpdatedAt, &connection.TerminatedAt,
		&connection.LocationFrozenAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrObjectStorageConnectionNotConfigured
		}
		return fmt.Errorf("creation: scan object storage connection: %w", err)
	}
	connection.Provider = domain.ObjectStorageProvider(provider)
	connection.State = domain.ObjectStorageState(state)
	connection.Envelope = &envelope
	return nil
}
