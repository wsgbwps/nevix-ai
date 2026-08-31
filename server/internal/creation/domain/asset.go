package domain

import (
	"context"
	"time"
)

// MediaAsset is one verified provider output formed into an independent,
// immutable aggregate (spec #150 聚合边界/输出持久化): it exists only after
// the streamed transfer passed MIME, checksum, dimension, and size
// verification, it is unique per (task, slot), and its lifecycle is
// independent of the origin session, task, and slot projection. Slice 10
// forms image (PNG) assets; team-readable browsing lands with slice 12.
type MediaAsset struct {
	ID         UUID
	OwnerID    UUID // creator, snapshotted for later team-readable queries
	TaskID     UUID
	SlotIndex  int
	MediaType  MediaType
	Mime       string
	ByteSize   int64
	Checksum   []byte // SHA-256
	BlobKey    string
	WidthPx    *int
	HeightPx   *int
	DurationMS *int
	CreatedAt  time.Time
}

// MediaAssetFormation is the fact set a succeeded slot verdict carries into
// the same transaction: the verified transfer result plus the aggregate's
// origin.
type MediaAssetFormation struct {
	OwnerID    UUID
	TaskID     UUID
	SlotIndex  int
	MediaType  MediaType
	Mime       string
	BlobKey    string
	ByteSize   int64
	Checksum   []byte
	WidthPx    *int
	HeightPx   *int
	DurationMS *int
}

// MediaAssetRepository persists formed assets. Insert is an idempotent
// formation write: a repeated poll, worker completion, or crash-recovery
// transfer must never duplicate the unique (task, slot) row.
type MediaAssetRepository interface {
	// InsertMediaAsset inserts one formation, ignoring a (task, slot) row
	// that already exists, and reports whether this call created it.
	InsertMediaAsset(ctx context.Context, tx TxExecutor, formation MediaAssetFormation) (bool, error)
}
