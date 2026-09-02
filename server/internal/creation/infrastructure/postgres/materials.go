package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// MaterialRepository reads off the pool and writes through caller-provided
// verified transactions.
type MaterialRepository struct {
	pool *pgxpool.Pool
}

func NewMaterialRepository(pool *pgxpool.Pool) *MaterialRepository {
	return &MaterialRepository{pool: pool}
}

const materialColumns = `
	m.id, m.session_id, m.kind, m.file_name, m.mime_type, m.byte_size,
	m.checksum_sha256, m.blob_key, m.width_px, m.height_px, m.pixel_count,
	m.duration_ms, m.claims_version, m.created_at`

const materialOwnershipJoin = `
	FROM creation_reference_materials m
	JOIN creation_sessions s ON s.id = m.session_id AND s.owner_user_id = $1 AND s.deleted_at IS NULL`

// Insert persists the validated material and stamps its creation time.
func (r *MaterialRepository) Insert(ctx context.Context, tx domain.TxExecutor, m *domain.ReferenceMaterial) error {
	err := tx.QueryRow(ctx, `
		INSERT INTO creation_reference_materials (
			id, session_id, kind, file_name, mime_type, byte_size, checksum_sha256,
			blob_key, width_px, height_px, pixel_count, duration_ms, claims_version
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		RETURNING created_at`,
		m.ID, m.SessionID, string(m.Kind), m.FileName, m.MimeType, m.ByteSize,
		m.ChecksumSHA256, m.BlobKey, m.WidthPx, m.HeightPx, m.PixelCount,
		m.DurationMS, m.ClaimsVersion,
	).Scan(&m.CreatedAt)
	if err != nil {
		return fmt.Errorf("creation: insert reference material: %w", err)
	}
	return nil
}

// GetForRead resolves one material through an active owned session; every
// miss — absent id, foreign creator, deleted session — collapses into
// ErrMaterialNotFound so guessing ids learns nothing.
func (r *MaterialRepository) GetForRead(ctx context.Context, owner, id domain.UUID) (domain.ReferenceMaterial, error) {
	row := r.pool.QueryRow(ctx,
		`SELECT `+materialColumns+materialOwnershipJoin+` WHERE m.id = $2`, owner, id)
	return scanMaterial(row)
}

// ListBySession pages a session's materials oldest-first: pile order equals
// upload order.
func (r *MaterialRepository) ListBySession(ctx context.Context, owner, sessionID domain.UUID, cursor *domain.CompoundCursor, limit int) ([]domain.ReferenceMaterial, *domain.CompoundCursor, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+materialColumns+materialOwnershipJoin+`
		WHERE m.session_id = $2
		  AND ($3::timestamptz IS NULL OR (m.created_at, m.id) > ($3::timestamptz, $4::uuid))
		ORDER BY m.created_at ASC, m.id ASC
		LIMIT $5`,
		owner, sessionID, cursorTime(cursor), cursorID(cursor), limit+1)
	if err != nil {
		return nil, nil, fmt.Errorf("creation: list materials: %w", err)
	}
	defer rows.Close()
	materials := make([]domain.ReferenceMaterial, 0, limit)
	for rows.Next() {
		material, err := scanMaterialRows(rows)
		if err != nil {
			return nil, nil, err
		}
		materials = append(materials, material)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("creation: list materials rows: %w", err)
	}
	next := nextCursor(len(materials), limit, func(i int) (time.Time, domain.UUID) {
		return materials[i].CreatedAt, materials[i].ID
	})
	return truncatePage(materials, limit), next, nil
}

// Delete removes one material row for its creator via an active session and
// returns the blob key whose cleanup follows commit.
func (r *MaterialRepository) Delete(ctx context.Context, tx domain.TxExecutor, owner, id domain.UUID) (string, error) {
	row := tx.QueryRow(ctx, `
		DELETE FROM creation_reference_materials m
		USING creation_sessions s
		WHERE s.id = m.session_id AND s.owner_user_id = $1 AND s.deleted_at IS NULL
		  AND m.id = $2
		RETURNING m.blob_key`, owner, id)
	var blobKey string
	err := row.Scan(&blobKey)
	if errors.Is(err, noRowsErr) {
		return "", domain.ErrMaterialNotFound
	}
	if err != nil {
		return "", fmt.Errorf("creation: delete reference material: %w", err)
	}
	return blobKey, nil
}

func scanMaterial(row rowScanner) (domain.ReferenceMaterial, error) {
	var m domain.ReferenceMaterial
	var kind string
	err := row.Scan(&m.ID, &m.SessionID, &kind, &m.FileName, &m.MimeType, &m.ByteSize,
		&m.ChecksumSHA256, &m.BlobKey, &m.WidthPx, &m.HeightPx, &m.PixelCount,
		&m.DurationMS, &m.ClaimsVersion, &m.CreatedAt)
	if errors.Is(err, noRowsErr) {
		return domain.ReferenceMaterial{}, domain.ErrMaterialNotFound
	}
	if err != nil {
		return domain.ReferenceMaterial{}, fmt.Errorf("creation: get material: %w", err)
	}
	m.Kind = domain.Kind(kind)
	return m, nil
}

func scanMaterialRows(rows interface {
	Next() bool
	Scan(dest ...any) error
}) (domain.ReferenceMaterial, error) {
	var m domain.ReferenceMaterial
	var kind string
	err := rows.Scan(&m.ID, &m.SessionID, &kind, &m.FileName, &m.MimeType, &m.ByteSize,
		&m.ChecksumSHA256, &m.BlobKey, &m.WidthPx, &m.HeightPx, &m.PixelCount,
		&m.DurationMS, &m.ClaimsVersion, &m.CreatedAt)
	if err != nil {
		return domain.ReferenceMaterial{}, fmt.Errorf("creation: scan material row: %w", err)
	}
	m.Kind = domain.Kind(kind)
	return m, nil
}

// LoadMaterialsInSession resolves the requested materials with full facts on
// the caller's transaction; materials outside the (active, owned) session are
// simply absent so admission can treat absence as a rejection fact.
func (r *MaterialRepository) LoadMaterialsInSession(ctx context.Context, tx domain.TxExecutor, owner, sessionID domain.UUID, ids []domain.UUID) ([]domain.ReferenceMaterial, error) {
	if len(ids) == 0 {
		return []domain.ReferenceMaterial{}, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT m.id, m.session_id, m.kind, m.file_name, m.mime_type, m.byte_size, m.checksum_sha256,
		       m.blob_key, m.width_px, m.height_px, m.pixel_count, m.duration_ms, m.claims_version, m.created_at
		FROM creation_reference_materials m
		JOIN creation_sessions s ON s.id = m.session_id
		WHERE m.session_id = $1 AND s.owner_user_id = $2 AND s.deleted_at IS NULL
		  AND m.id = ANY($3::uuid[])`,
		sessionID, owner, ids)
	if err != nil {
		return nil, fmt.Errorf("creation: load materials in session: %w", err)
	}
	defer rows.Close()
	materials := []domain.ReferenceMaterial{}
	for rows.Next() {
		var m domain.ReferenceMaterial
		if err := rows.Scan(&m.ID, &m.SessionID, &m.Kind, &m.FileName, &m.MimeType, &m.ByteSize,
			&m.ChecksumSHA256, &m.BlobKey, &m.WidthPx, &m.HeightPx, &m.PixelCount, &m.DurationMS,
			&m.ClaimsVersion, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("creation: scan material: %w", err)
		}
		materials = append(materials, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("creation: load materials in session rows: %w", err)
	}
	return materials, nil
}
