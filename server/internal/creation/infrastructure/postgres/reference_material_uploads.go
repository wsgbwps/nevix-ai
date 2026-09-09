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
	u.put_deadline, u.finalize_deadline, u.status, u.created_at, u.finalized_at,
	u.verification_token, u.verification_lease_until, u.terminal_at,
	u.cleanup_attempt_count, u.cleanup_next_attempt_at, u.cleanup_confirmed_at`

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
			put_deadline, finalize_deadline, status, created_at, finalized_at,
			verification_token, verification_lease_until, terminal_at,
			cleanup_attempt_count, cleanup_next_attempt_at, cleanup_confirmed_at`,
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
		WHERE u.id = $2 AND u.owner_user_id = $1`, owner, id))
}

func (r *ReferenceMaterialUploadRepository) GetByIdempotency(ctx context.Context, owner domain.UUID, key string) (domain.ReferenceMaterialUpload, error) {
	return scanReferenceMaterialUpload(r.pool.QueryRow(ctx, `
		SELECT `+referenceMaterialUploadColumns+`
		FROM creation_reference_material_uploads u
		WHERE u.owner_user_id = $1 AND u.idempotency_key = $2`, owner, key))
}

func (r *ReferenceMaterialUploadRepository) LockForMutation(ctx context.Context, tx domain.TxExecutor, owner, id domain.UUID) (domain.ReferenceMaterialUpload, error) {
	return scanReferenceMaterialUpload(tx.QueryRow(ctx, `
		SELECT `+referenceMaterialUploadColumns+`
		FROM creation_reference_material_uploads u
		WHERE u.id = $2 AND u.owner_user_id = $1
		FOR UPDATE`, owner, id))
}

func (r *ReferenceMaterialUploadRepository) CreatorCanFinalize(ctx context.Context, tx domain.TxExecutor, owner, sessionID domain.UUID) (bool, error) {
	var eligible int
	err := tx.QueryRow(ctx, `
		SELECT 1
		FROM creation_sessions s
		JOIN users u ON u.id = s.owner_user_id
		WHERE s.id = $2 AND s.owner_user_id = $1
		  AND s.deleted_at IS NULL AND u.status = 'active'
		FOR UPDATE OF s, u`, owner, sessionID).Scan(&eligible)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("creation: inspect reference material upload eligibility: %w", err)
	}
	return eligible == 1, nil
}

func (r *ReferenceMaterialUploadRepository) MarkVerifying(ctx context.Context, tx domain.TxExecutor, owner, id, token domain.UUID, leaseUntil domain.Time) error {
	tag, err := tx.Exec(ctx, `
		UPDATE creation_reference_material_uploads
		SET status = 'verifying', verification_token = $3, verification_lease_until = $4
		WHERE id = $2 AND owner_user_id = $1 AND status IN ('pending', 'verifying')`, owner, id, token, leaseUntil)
	if err != nil {
		return fmt.Errorf("creation: claim reference material upload verification: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrReferenceMaterialUploadNotFound
	}
	return nil
}

func (r *ReferenceMaterialUploadRepository) MarkPending(ctx context.Context, tx domain.TxExecutor, owner, id, token domain.UUID) error {
	tag, err := tx.Exec(ctx, `
		UPDATE creation_reference_material_uploads
		SET status = 'pending', verification_token = NULL, verification_lease_until = NULL
		WHERE id = $2 AND owner_user_id = $1
		  AND status = 'verifying' AND verification_token = $3`, owner, id, token)
	if err != nil {
		return fmt.Errorf("creation: release reference material upload verification: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrReferenceMaterialUploadVerifying
	}
	return nil
}

func (r *ReferenceMaterialUploadRepository) MarkFinalized(ctx context.Context, tx domain.TxExecutor, owner, id, token domain.UUID, finalizedAt domain.Time) error {
	tag, err := tx.Exec(ctx, `
		UPDATE creation_reference_material_uploads
		SET status = 'finalized', finalized_at = $4,
		    verification_token = NULL, verification_lease_until = NULL
		WHERE id = $2 AND owner_user_id = $1
		  AND status = 'verifying' AND verification_token = $3`, owner, id, token, finalizedAt)
	if err != nil {
		return fmt.Errorf("creation: finalize reference material upload: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrReferenceMaterialUploadVerifying
	}
	return nil
}

func (r *ReferenceMaterialUploadRepository) MarkTerminal(ctx context.Context, tx domain.TxExecutor, owner, id domain.UUID, token *domain.UUID, terminalAt domain.Time) error {
	tag, err := tx.Exec(ctx, `
		UPDATE creation_reference_material_uploads
		SET status = 'terminal', terminal_at = $4::timestamptz,
		    verification_token = NULL, verification_lease_until = NULL,
		    cleanup_attempt_count = 1,
		    cleanup_next_attempt_at = $4::timestamptz + interval '1 minute'
		WHERE id = $2 AND owner_user_id = $1
		  AND (($3::uuid IS NULL AND status = 'pending')
		    OR ($3::uuid IS NOT NULL AND status = 'verifying' AND verification_token = $3))`,
		owner, id, token, terminalAt)
	if err != nil {
		return fmt.Errorf("creation: terminalize reference material upload: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrReferenceMaterialUploadVerifying
	}
	return nil
}

func (r *ReferenceMaterialUploadRepository) ScheduleFinalizedMaterialCleanup(ctx context.Context, tx domain.TxExecutor, cleanup *domain.ReferenceMaterialUpload) error {
	tag, err := tx.Exec(ctx, `
		UPDATE creation_reference_material_uploads
		SET cleanup_attempt_count = 1,
		    cleanup_next_attempt_at = $3,
		    cleanup_confirmed_at = NULL
		WHERE owner_user_id = $1 AND material_id = $2 AND status = 'finalized'`,
		cleanup.OwnerID, cleanup.MaterialID, cleanup.CleanupNextAttemptAt)
	if err != nil {
		return fmt.Errorf("creation: schedule finalized reference material cleanup: %w", err)
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO creation_reference_material_uploads (
			id, owner_user_id, session_id, material_id, object_key, file_name,
			declared_kind, declared_mime_type, declared_byte_size, claims_version,
			idempotency_key, payload_hash, connection_revision, put_deadline,
			finalize_deadline, status, created_at, finalized_at,
			cleanup_attempt_count, cleanup_next_attempt_at
		) VALUES (
			$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
		)`,
		cleanup.ID, cleanup.OwnerID, cleanup.SessionID, cleanup.MaterialID,
		cleanup.ObjectKey, cleanup.FileName, string(cleanup.DeclaredKind),
		cleanup.DeclaredMIMEType, cleanup.DeclaredByteSize, cleanup.ClaimsVersion,
		cleanup.IdempotencyKey, cleanup.PayloadHash, cleanup.ConnectionRevision,
		cleanup.PutDeadline, cleanup.FinalizeDeadline, string(cleanup.Status),
		cleanup.CreatedAt, cleanup.FinalizedAt, cleanup.CleanupAttemptCount,
		cleanup.CleanupNextAttemptAt)
	if err != nil {
		return fmt.Errorf("creation: insert finalized reference material cleanup: %w", err)
	}
	return nil
}

func (r *ReferenceMaterialUploadRepository) TerminalizeExpiredOrInvalid(ctx context.Context, tx domain.TxExecutor, now domain.Time, limit int) error {
	_, err := tx.Exec(ctx, `
		WITH candidates AS (
			SELECT u.id
			FROM creation_reference_material_uploads u
			WHERE u.status IN ('pending', 'verifying')
			  AND (u.finalize_deadline <= $1 OR NOT EXISTS (
				SELECT 1 FROM creation_sessions s
				JOIN users owner ON owner.id = s.owner_user_id
				WHERE s.id = u.session_id AND s.owner_user_id = u.owner_user_id
				  AND s.deleted_at IS NULL AND owner.status = 'active'
			  ))
			ORDER BY u.finalize_deadline, u.id
			FOR UPDATE OF u SKIP LOCKED
			LIMIT $2
		)
		UPDATE creation_reference_material_uploads u
		SET status = 'terminal', terminal_at = $1,
		    verification_token = NULL, verification_lease_until = NULL,
		    cleanup_next_attempt_at = $1
		FROM candidates c WHERE u.id = c.id`, now, limit)
	if err != nil {
		return fmt.Errorf("creation: terminalize expired reference material uploads: %w", err)
	}
	return nil
}

func (r *ReferenceMaterialUploadRepository) LockDueCleanups(ctx context.Context, tx domain.TxExecutor, now domain.Time, limit int) ([]domain.ReferenceMaterialUpload, error) {
	rows, err := tx.Query(ctx, `
		SELECT `+referenceMaterialUploadColumns+`
		FROM creation_reference_material_uploads u
		WHERE u.status IN ('terminal', 'finalized') AND u.cleanup_confirmed_at IS NULL
		  AND u.cleanup_next_attempt_at <= $1
		ORDER BY u.cleanup_next_attempt_at, u.id
		FOR UPDATE SKIP LOCKED
		LIMIT $2`, now, limit)
	if err != nil {
		return nil, fmt.Errorf("creation: lock due reference material cleanup: %w", err)
	}
	defer rows.Close()
	uploads := make([]domain.ReferenceMaterialUpload, 0, limit)
	for rows.Next() {
		upload, err := scanReferenceMaterialUpload(rows)
		if err != nil {
			return nil, err
		}
		uploads = append(uploads, upload)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("creation: iterate reference material cleanup: %w", err)
	}
	return uploads, nil
}

func (r *ReferenceMaterialUploadRepository) MarkCleanupAttempt(ctx context.Context, tx domain.TxExecutor, id domain.UUID, nextAttemptAt domain.Time) (domain.ReferenceMaterialUploadCleanup, error) {
	var cleanup domain.ReferenceMaterialUploadCleanup
	err := tx.QueryRow(ctx, `
		UPDATE creation_reference_material_uploads
		SET cleanup_attempt_count = cleanup_attempt_count + 1,
		    cleanup_next_attempt_at = $2
		WHERE id = $1 AND status IN ('terminal', 'finalized') AND cleanup_confirmed_at IS NULL
		RETURNING id, object_key, cleanup_attempt_count, finalize_deadline`, id, nextAttemptAt).Scan(
		&cleanup.UploadID, &cleanup.ObjectKey, &cleanup.Attempt, &cleanup.FinalizeDeadline,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ReferenceMaterialUploadCleanup{}, domain.ErrReferenceMaterialUploadNotFound
	}
	if err != nil {
		return domain.ReferenceMaterialUploadCleanup{}, fmt.Errorf("creation: claim reference material cleanup: %w", err)
	}
	return cleanup, nil
}

func (r *ReferenceMaterialUploadRepository) MarkCleanupConfirmed(ctx context.Context, tx domain.TxExecutor, id domain.UUID, attempt int, confirmedAt domain.Time) error {
	_, err := tx.Exec(ctx, `
		UPDATE creation_reference_material_uploads
		SET cleanup_confirmed_at = $3, cleanup_next_attempt_at = NULL
		WHERE id = $1 AND status IN ('terminal', 'finalized') AND cleanup_confirmed_at IS NULL
		  AND cleanup_attempt_count = $2`, id, attempt, confirmedAt)
	if err != nil {
		return fmt.Errorf("creation: confirm reference material cleanup: %w", err)
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
		&upload.VerificationToken, &upload.VerificationLeaseUntil, &upload.TerminalAt,
		&upload.CleanupAttemptCount, &upload.CleanupNextAttemptAt, &upload.CleanupConfirmedAt,
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
