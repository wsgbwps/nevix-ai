package postgres

import (
	"context"
	"errors"
	"fmt"

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
	created_by_user_id, created_at, updated_at, terminated_at`

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

func (r *ObjectStorageConnectionRepository) MarkCredentialUnavailable(ctx context.Context, tx domain.TxExecutor, id domain.UUID) error {
	tag, err := tx.Exec(ctx, `
		UPDATE object_storage_connections
		SET state = 'credential_unavailable', updated_at = now()
		WHERE id = $1 AND terminated_at IS NULL`, id)
	if err != nil {
		return fmt.Errorf("creation: mark object storage credential unavailable: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrObjectStorageConnectionNotConfigured
	}
	return nil
}

func scanObjectStorageConnection(row pgx.Row, connection *domain.ObjectStorageConnection) error {
	var provider, state string
	var envelope domain.ObjectStorageCredentialEnvelope
	if err := row.Scan(
		&connection.ID, &provider, &connection.Region, &connection.Bucket, &connection.Revision, &state,
		&envelope.Version, &envelope.KeyID, &envelope.Nonce, &envelope.Ciphertext,
		&connection.AccessKeyIDMasked, &connection.LastCheckedAt, &connection.LastCheckOutcome,
		&connection.CreatedByUserID, &connection.CreatedAt, &connection.UpdatedAt, &connection.TerminatedAt,
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
