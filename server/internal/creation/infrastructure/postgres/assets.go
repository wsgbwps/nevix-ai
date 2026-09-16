package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
)

type MediaAssetRepository struct {
	pool *pgxpool.Pool
}

func NewMediaAssetRepository(pool *pgxpool.Pool) *MediaAssetRepository {
	return &MediaAssetRepository{pool: pool}
}

func (r *MediaAssetRepository) InsertMediaAsset(ctx context.Context, tx domain.TxExecutor, formation domain.MediaAssetFormation) (bool, error) {
	tag, err := tx.Exec(ctx, `
		INSERT INTO creation_media_assets
			(owner_user_id, task_id, slot_index, media_type, mime, blob_key, byte_size, checksum,
			 width_px, height_px, duration_ms)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (task_id, slot_index) DO NOTHING`,
		formation.OwnerID, formation.TaskID, formation.SlotIndex, formation.MediaType, formation.Mime,
		formation.BlobKey, formation.ByteSize, formation.Checksum,
		formation.WidthPx, formation.HeightPx, formation.DurationMS)
	if err != nil {
		return false, fmt.Errorf("creation: insert media asset: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

const assetColumns = `a.id, a.owner_user_id, u.display_name, a.task_id, a.slot_index,
	a.media_type, a.mime, a.blob_key, a.byte_size, a.checksum,
	a.width_px, a.height_px, a.duration_ms, a.created_at`

func (r *MediaAssetRepository) ListVisible(ctx context.Context, filter domain.AssetListFilter, cursor *domain.CompoundCursor, limit int) ([]domain.MediaAsset, *domain.CompoundCursor, error) {
	args := make([]any, 0, 7)
	conditions := []string{"a.deleted_at IS NULL", "a.restricted_at IS NULL"}
	add := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}
	if filter.MediaType != nil {
		conditions = append(conditions, "a.media_type = "+add(string(*filter.MediaType)))
	}
	creatorPrefix := func(value string) {
		pattern := escapeLike(strings.ToLower(value)) + "%"
		conditions = append(conditions, `a.owner_user_id IN (
			SELECT id FROM users WHERE lower(display_name) LIKE `+add(pattern)+` ESCAPE '\')`)
	}
	if creator := strings.TrimSpace(filter.Creator); creator != "" {
		creatorPrefix(creator)
	}
	if filter.CreatedSince != nil {
		conditions = append(conditions, "a.created_at >= "+add(filter.CreatedSince.UTC()))
	}
	if search := strings.TrimSpace(filter.Search); search != "" {
		if id, err := domain.ParseUUID(search); err == nil {
			conditions = append(conditions, "a.id = "+add(id))
		} else {
			creatorPrefix(search)
		}
	}
	direction, comparison := "DESC", "<"
	if filter.Sort == domain.AssetOldest {
		direction, comparison = "ASC", ">"
	}
	if cursor != nil {
		at := add(cursor.CreatedAt.UTC())
		id := add(cursor.ID)
		conditions = append(conditions, fmt.Sprintf("(a.created_at, a.id) %s (%s, %s)", comparison, at, id))
	}
	args = append(args, limit+1)
	query := `SELECT ` + assetColumns + `
		FROM creation_media_assets a JOIN users u ON u.id = a.owner_user_id
		WHERE ` + strings.Join(conditions, " AND ") + `
		ORDER BY a.created_at ` + direction + `, a.id ` + direction + `
		LIMIT ` + fmt.Sprintf("$%d", len(args))
	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("creation: list visible assets: %w", err)
	}
	defer rows.Close()
	assets := make([]domain.MediaAsset, 0, limit)
	for rows.Next() {
		asset, err := scanAsset(rows)
		if err != nil {
			return nil, nil, fmt.Errorf("creation: scan visible asset: %w", err)
		}
		assets = append(assets, asset)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("creation: list visible assets rows: %w", err)
	}
	next := nextCursor(len(assets), limit, func(i int) (time.Time, domain.UUID) {
		return assets[i].CreatedAt, assets[i].ID
	})
	return truncatePage(assets, limit), next, nil
}

func (r *MediaAssetRepository) GetVisible(ctx context.Context, id domain.UUID) (domain.MediaAsset, error) {
	asset, err := scanAsset(r.pool.QueryRow(ctx, `SELECT `+assetColumns+`
		FROM creation_media_assets a JOIN users u ON u.id = a.owner_user_id
		WHERE a.id = $1 AND a.deleted_at IS NULL AND a.restricted_at IS NULL`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.MediaAsset{}, domain.ErrAssetNotFound
	}
	if err != nil {
		return domain.MediaAsset{}, fmt.Errorf("creation: get visible asset: %w", err)
	}
	return asset, nil
}

func (r *MediaAssetRepository) ListVisibleSiblings(ctx context.Context, taskID domain.UUID) ([]domain.MediaAsset, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+assetColumns+`
		FROM creation_media_assets a JOIN users u ON u.id = a.owner_user_id
		WHERE a.task_id = $1 AND a.deleted_at IS NULL AND a.restricted_at IS NULL
		ORDER BY a.slot_index`, taskID)
	if err != nil {
		return nil, fmt.Errorf("creation: list visible asset siblings: %w", err)
	}
	defer rows.Close()
	assets := make([]domain.MediaAsset, 0, 4)
	for rows.Next() {
		asset, err := scanAsset(rows)
		if err != nil {
			return nil, fmt.Errorf("creation: scan visible asset sibling: %w", err)
		}
		assets = append(assets, asset)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("creation: list visible asset siblings rows: %w", err)
	}
	return assets, nil
}

func (r *MediaAssetRepository) GetPrivateOrigin(ctx context.Context, asset domain.MediaAsset) (*domain.AssetPrivateOrigin, error) {
	var (
		specJSON    []byte
		sessionID   domain.UUID
		sessionName *string
	)
	err := r.pool.QueryRow(ctx, `
		SELECT t.session_id, s.name, t.specification
		FROM creation_generation_tasks t
		LEFT JOIN creation_sessions s ON s.id = t.session_id
		WHERE t.id = $1 AND t.owner_user_id = $2`, asset.TaskID, asset.OwnerID).
		Scan(&sessionID, &sessionName, &specJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("creation: get asset private origin: %w", err)
	}
	var spec domain.GenerationSpecification
	if json.Unmarshal(specJSON, &spec) != nil {
		// A broken private source cannot make the independently formed Asset unreadable.
		return nil, nil
	}
	return &domain.AssetPrivateOrigin{
		SessionID: sessionID, SessionName: sessionName, TaskID: asset.TaskID,
		SlotIndex: asset.SlotIndex, Spec: spec,
	}, nil
}

func (r *MediaAssetRepository) SoftDelete(ctx context.Context, tx domain.TxExecutor, actor, id domain.UUID, admin bool) error {
	query := `UPDATE creation_media_assets SET deleted_at = now()
		WHERE id = $1 AND deleted_at IS NULL AND restricted_at IS NULL`
	args := []any{id}
	if !admin {
		query += " AND owner_user_id = $2"
		args = append(args, actor)
	}
	count, err := execTx(tx, ctx, query, args...)
	if err != nil {
		return fmt.Errorf("creation: soft delete asset: %w", err)
	}
	if count != 1 {
		return domain.ErrAssetNotFound
	}
	return nil
}

func scanAsset(row rowScanner) (domain.MediaAsset, error) {
	var asset domain.MediaAsset
	var media string
	err := row.Scan(
		&asset.ID, &asset.OwnerID, &asset.CreatorDisplayName, &asset.TaskID, &asset.SlotIndex,
		&media, &asset.Mime, &asset.BlobKey, &asset.ByteSize, &asset.Checksum,
		&asset.WidthPx, &asset.HeightPx, &asset.DurationMS, &asset.CreatedAt,
	)
	asset.MediaType = domain.MediaType(media)
	return asset, err
}

func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}
