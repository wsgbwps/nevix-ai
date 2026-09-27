package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
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
	JOIN creation_sessions s ON s.id = m.session_id AND s.owner_user_id = $1
		AND s.deleted_at IS NULL AND m.removed_at IS NULL`

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
// miss — absent/removed id, foreign creator, deleted session — collapses into
// ErrMaterialNotFound so guessing ids learns nothing.
func (r *MaterialRepository) GetForRead(ctx context.Context, owner, id domain.UUID) (domain.ReferenceMaterial, error) {
	row := r.pool.QueryRow(ctx,
		`SELECT `+materialColumns+materialOwnershipJoin+` WHERE m.id = $2`, owner, id)
	return scanMaterial(row)
}

// GetForThumbnail admits a removed material only through an explicit retained
// task owned by the same creator. A deleted session does not release an
// immutable task's retention fact.
func (r *MaterialRepository) GetForThumbnail(ctx context.Context, owner, id domain.UUID) (domain.ReferenceMaterial, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT `+materialColumns+`
		FROM creation_reference_materials m
		JOIN creation_sessions s ON s.id = m.session_id AND s.owner_user_id = $1
		WHERE m.id = $2 AND (
			(m.removed_at IS NULL AND s.deleted_at IS NULL)
			OR EXISTS (
				SELECT 1
				FROM creation_generation_task_references retained
				JOIN creation_generation_tasks task ON task.id = retained.task_id
				WHERE retained.material_id = m.id AND task.owner_user_id = $1
				  AND task.dismissed_at IS NULL
			)
		)`, owner, id)
	return scanMaterial(row)
}

func (r *MaterialRepository) GetForTask(ctx context.Context, owner, taskID, materialID domain.UUID) (domain.ReferenceMaterial, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT `+materialColumns+`
		FROM creation_reference_materials m
		JOIN creation_sessions s ON s.id = m.session_id AND s.owner_user_id = $1
		JOIN creation_generation_task_references retained ON retained.material_id = m.id
		JOIN creation_generation_tasks task ON task.id = retained.task_id
			AND task.owner_user_id = $1 AND task.dismissed_at IS NULL
		WHERE task.id = $2 AND m.id = $3`, owner, taskID, materialID)
	return scanMaterial(row)
}

func (r *MaterialRepository) GetForReadInTx(ctx context.Context, tx domain.TxExecutor, owner, id domain.UUID) (domain.ReferenceMaterial, error) {
	row := tx.QueryRow(ctx,
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

func (r *MaterialRepository) ListLegacyRemoved(ctx context.Context, after *domain.UUID, limit int) ([]domain.ReferenceMaterial, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+materialColumns+`
		FROM creation_reference_materials m
		JOIN creation_sessions s ON s.id = m.session_id
		WHERE m.removed_at IS NOT NULL AND (
			s.deleted_at IS NULL OR (m.legacy_object_verified_at IS NULL AND EXISTS (
				SELECT 1 FROM creation_generation_task_references retained
				JOIN creation_generation_tasks task ON task.id = retained.task_id
				WHERE retained.material_id = m.id AND task.dismissed_at IS NULL
			))
		)
		  AND ($1::uuid IS NULL OR m.id > $1)
		ORDER BY m.id LIMIT $2`, after, limit)
	if err != nil {
		return nil, fmt.Errorf("creation: list legacy removed materials: %w", err)
	}
	defer rows.Close()
	materials := make([]domain.ReferenceMaterial, 0, limit)
	for rows.Next() {
		material, err := scanMaterialRows(rows)
		if err != nil {
			return nil, err
		}
		materials = append(materials, material)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("creation: list legacy removed material rows: %w", err)
	}
	return materials, nil
}

// Serialize recovery and cleanup for one object without holding a write
// transaction across object storage I/O.
func (r *MaterialRepository) WithObjectLock(ctx context.Context, key string, work func() error) error {
	conn, err := pgx.ConnectConfig(ctx, r.pool.Config().ConnConfig.Copy())
	if err != nil {
		return fmt.Errorf("creation: connect object lock: %w", err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = conn.Close(closeCtx)
	}()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1, 320))`, key); err != nil {
		return fmt.Errorf("creation: lock object: %w", err)
	}
	return work()
}

func (r *MaterialRepository) ConfirmLegacyObject(ctx context.Context, tx domain.TxExecutor, id domain.UUID) (bool, error) {
	// Keep session deletion behind recovery's material and cleanup-fact writes.
	var found int
	err := tx.QueryRow(ctx, `SELECT 1 FROM creation_sessions s
		JOIN creation_reference_materials m ON m.session_id = s.id
		WHERE m.id = $1 FOR SHARE OF s`, id).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("creation: lock legacy material session: %w", err)
	}
	var key string
	var restored bool
	err = tx.QueryRow(ctx, `
		UPDATE creation_reference_materials m
		SET removed_at = CASE WHEN s.deleted_at IS NULL THEN NULL ELSE m.removed_at END,
		    legacy_object_verified_at = CASE WHEN s.deleted_at IS NULL THEN NULL ELSE clock_timestamp() END
		FROM creation_sessions s
		WHERE m.id = $1 AND m.removed_at IS NOT NULL
		  AND s.id = m.session_id
		  AND (s.deleted_at IS NULL OR (m.legacy_object_verified_at IS NULL AND EXISTS (
			SELECT 1 FROM creation_generation_task_references retained
			JOIN creation_generation_tasks task ON task.id = retained.task_id
			WHERE retained.material_id = m.id AND task.dismissed_at IS NULL
		  )))
		RETURNING m.blob_key, m.removed_at IS NULL`, id).Scan(&key, &restored)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("creation: confirm legacy material object: %w", err)
	}
	if restored {
		if _, err := tx.Exec(ctx, `UPDATE creation_reference_material_uploads
			SET cleanup_attempt_count = 0, cleanup_next_attempt_at = NULL
			WHERE object_key = $1 AND status = 'finalized' AND cleanup_confirmed_at IS NULL`, key); err != nil {
			return false, fmt.Errorf("creation: disarm recovered material cleanup: %w", err)
		}
	}
	return true, nil
}

func (r *MaterialRepository) ReleaseDismissedReferences(ctx context.Context, tx domain.TxExecutor, limit int) (int64, error) {
	tag, err := tx.Exec(ctx, `
		WITH stale AS (
			SELECT retained.task_id, retained.material_id
			FROM creation_generation_task_references retained
			JOIN creation_generation_tasks task ON task.id = retained.task_id
			WHERE task.dismissed_at IS NOT NULL
			ORDER BY retained.material_id, retained.task_id LIMIT $1
		)
		DELETE FROM creation_generation_task_references retained
		USING stale
		WHERE retained.task_id = stale.task_id AND retained.material_id = stale.material_id`, limit)
	if err != nil {
		return 0, fmt.Errorf("creation: release dismissed task references: %w", err)
	}
	return tag.RowsAffected(), nil
}

// Remove hides one active material from Composer and reports whether any
// material, task, or active publication still retains its immutable object.
func (r *MaterialRepository) Remove(ctx context.Context, tx domain.TxExecutor, owner, id domain.UUID) (domain.ReferenceMaterial, bool, error) {
	material, err := scanMaterial(tx.QueryRow(ctx, `
		UPDATE creation_reference_materials m
		SET removed_at = clock_timestamp()
		FROM creation_sessions s
		WHERE s.id = m.session_id AND s.owner_user_id = $1 AND s.deleted_at IS NULL
		  AND m.id = $2 AND m.removed_at IS NULL
		RETURNING `+materialColumns, owner, id))
	if err != nil {
		return domain.ReferenceMaterial{}, false, err
	}
	// Read after acquiring the material lock so a just-committed admission or
	// final task release is visible in this statement's fresh snapshot.
	var retained bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM creation_reference_materials alias
			WHERE alias.blob_key = $1 AND alias.removed_at IS NULL
		) OR EXISTS (
			SELECT 1 FROM creation_generation_task_references retained
			JOIN creation_reference_materials source ON source.id = retained.material_id
			WHERE source.blob_key = $1
		) OR EXISTS (
			SELECT 1 FROM creation_team_publication_references reference
			JOIN creation_team_publications publication ON publication.id = reference.publication_id
			WHERE reference.blob_key = $1
			  AND publication.withdrawn_at IS NULL AND publication.restricted_at IS NULL
		)`, material.BlobKey).Scan(&retained); err != nil {
		return domain.ReferenceMaterial{}, false, fmt.Errorf("creation: read material retention: %w", err)
	}
	return material, retained, nil
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
		  AND m.removed_at IS NULL AND m.id = ANY($3::uuid[])
		ORDER BY m.id
		FOR SHARE OF m`,
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
