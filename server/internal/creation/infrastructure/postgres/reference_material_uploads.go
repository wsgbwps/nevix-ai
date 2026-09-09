package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
)

type ReferenceMaterialUploadRepository struct {
	pool *pgxpool.Pool
}

func NewReferenceMaterialUploadRepository(pool *pgxpool.Pool) *ReferenceMaterialUploadRepository {
	return &ReferenceMaterialUploadRepository{pool: pool}
}

const referenceMaterialUploadColumns = `
	u.id, u.owner_user_id, u.session_id, u.material_id, u.object_key,
	u.file_name, u.declared_kind, u.declared_mime_type, u.declared_byte_size,
	u.claims_version, u.idempotency_key, u.payload_hash, u.connection_revision,
	u.put_deadline, u.finalize_deadline, u.status, u.created_at, u.finalized_at`

func (r *ReferenceMaterialUploadRepository) UpsertByIdempotency(ctx context.Context, tx domain.TxExecutor, upload *domain.ReferenceMaterialUpload) (domain.ReferenceMaterialUpload, error) {
	var currentRevision int64
	err := tx.QueryRow(ctx, `
		SELECT revision FROM object_storage_connections
		WHERE terminated_at IS NULL FOR UPDATE`).Scan(&currentRevision)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && currentRevision != upload.ConnectionRevision) {
		return domain.ReferenceMaterialUpload{}, domain.ErrObjectStorageUnavailable
	}
	if err != nil {
		return domain.ReferenceMaterialUpload{}, fmt.Errorf("creation: lock object storage connection for upload: %w", err)
	}
	row := tx.QueryRow(ctx, `
		INSERT INTO creation_reference_material_uploads (
			id, owner_user_id, session_id, material_id, object_key, file_name,
			declared_kind, declared_mime_type, declared_byte_size, claims_version,
			idempotency_key, payload_hash, connection_revision, put_deadline,
			finalize_deadline, status, created_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
		ON CONFLICT (owner_user_id, idempotency_key) DO UPDATE
		SET idempotency_key = EXCLUDED.idempotency_key
		RETURNING id, owner_user_id, session_id, material_id, object_key,
			file_name, declared_kind, declared_mime_type, declared_byte_size,
			claims_version, idempotency_key, payload_hash, connection_revision,
			put_deadline, finalize_deadline, status, created_at, finalized_at`,
		upload.ID, upload.OwnerID, upload.SessionID, upload.MaterialID, upload.ObjectKey,
		upload.FileName, string(upload.DeclaredKind), upload.DeclaredMIMEType,
		upload.DeclaredByteSize, upload.ClaimsVersion, upload.IdempotencyKey,
		upload.PayloadHash, upload.ConnectionRevision, upload.PutDeadline,
		upload.FinalizeDeadline, string(upload.Status), upload.CreatedAt)
	return scanReferenceMaterialUpload(row)
}

func (r *ReferenceMaterialUploadRepository) GetForOwner(ctx context.Context, owner, id domain.UUID) (domain.ReferenceMaterialUpload, error) {
	return scanReferenceMaterialUpload(r.pool.QueryRow(ctx, `
		SELECT `+referenceMaterialUploadColumns+`
		FROM creation_reference_material_uploads u
		JOIN creation_sessions s ON s.id = u.session_id
		WHERE u.id = $2 AND u.owner_user_id = $1
		  AND s.owner_user_id = $1 AND s.deleted_at IS NULL`, owner, id))
}

func (r *ReferenceMaterialUploadRepository) GetByIdempotency(ctx context.Context, owner domain.UUID, key string) (domain.ReferenceMaterialUpload, error) {
	return scanReferenceMaterialUpload(r.pool.QueryRow(ctx, `
		SELECT `+referenceMaterialUploadColumns+`
		FROM creation_reference_material_uploads u
		JOIN creation_sessions s ON s.id = u.session_id
		WHERE u.owner_user_id = $1 AND u.idempotency_key = $2
		  AND s.owner_user_id = $1 AND s.deleted_at IS NULL`, owner, key))
}

func (r *ReferenceMaterialUploadRepository) LockForFinalize(ctx context.Context, tx domain.TxExecutor, owner, id domain.UUID) (domain.ReferenceMaterialUpload, error) {
	return scanReferenceMaterialUpload(tx.QueryRow(ctx, `
		SELECT `+referenceMaterialUploadColumns+`
		FROM creation_reference_material_uploads u
		JOIN creation_sessions s ON s.id = u.session_id
		WHERE u.id = $2 AND u.owner_user_id = $1
		  AND s.owner_user_id = $1 AND s.deleted_at IS NULL
		FOR UPDATE OF u`, owner, id))
}

func (r *ReferenceMaterialUploadRepository) MarkFinalized(ctx context.Context, tx domain.TxExecutor, owner, id domain.UUID, finalizedAt domain.Time) error {
	tag, err := tx.Exec(ctx, `
		UPDATE creation_reference_material_uploads
		SET status = 'finalized', finalized_at = $3
		WHERE id = $2 AND owner_user_id = $1 AND status = 'pending'`, owner, id, finalizedAt)
	if err != nil {
		return fmt.Errorf("creation: finalize reference material upload: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrReferenceMaterialUploadNotFound
	}
	return nil
}

func scanReferenceMaterialUpload(row pgx.Row) (domain.ReferenceMaterialUpload, error) {
	var upload domain.ReferenceMaterialUpload
	var kind, status string
	err := row.Scan(
		&upload.ID, &upload.OwnerID, &upload.SessionID, &upload.MaterialID,
		&upload.ObjectKey, &upload.FileName, &kind, &upload.DeclaredMIMEType,
		&upload.DeclaredByteSize, &upload.ClaimsVersion, &upload.IdempotencyKey,
		&upload.PayloadHash, &upload.ConnectionRevision, &upload.PutDeadline,
		&upload.FinalizeDeadline, &status, &upload.CreatedAt, &upload.FinalizedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ReferenceMaterialUpload{}, domain.ErrReferenceMaterialUploadNotFound
	}
	if err != nil {
		return domain.ReferenceMaterialUpload{}, fmt.Errorf("creation: scan reference material upload: %w", err)
	}
	upload.DeclaredKind = domain.Kind(kind)
	upload.Status = domain.ReferenceMaterialUploadStatus(status)
	return upload, nil
}
