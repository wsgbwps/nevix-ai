package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// MediaAssetRepository implements the media-asset formation port over
// PostgreSQL. Formation is idempotent by the (task_id, slot_index) unique
// constraint: a repeated poll, worker completion, or crash-recovery transfer
// lands on the conflict target and reports created=false instead of
// duplicating the aggregate (spec #150 Asset 唯一性).
type MediaAssetRepository struct {
	pool *pgxpool.Pool
}

func NewMediaAssetRepository(pool *pgxpool.Pool) *MediaAssetRepository {
	return &MediaAssetRepository{pool: pool}
}

// InsertMediaAsset inserts one verified formation inside the caller's
// transaction, ignoring a (task, slot) row that already exists.
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
