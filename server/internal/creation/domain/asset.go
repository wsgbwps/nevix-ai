package domain

import (
	"context"
	"time"
)

// MediaAsset is one verified provider output with an independent lifecycle.
type MediaAsset struct {
	ID                 UUID
	OwnerID            UUID
	CreatorDisplayName string
	TaskID             UUID
	SlotIndex          int
	MediaType          MediaType
	Mime               string
	ByteSize           int64
	Checksum           []byte
	BlobKey            string
	WidthPx            *int
	HeightPx           *int
	DurationMS         *int
	CreatedAt          time.Time
	Restricted         bool
	RestrictionState   RestrictionState
	ActivePublication  *TeamPublication
}

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

type AssetSort string

const (
	AssetNewest AssetSort = "newest"
	AssetOldest AssetSort = "oldest"
)

type AssetListFilter struct {
	MediaType    *MediaType
	Creator      string
	CreatedSince *time.Time
	Sort         AssetSort
	Search       string
}

type AssetPrivateOrigin struct {
	SessionID   UUID
	SessionName *string
	TaskID      UUID
	SlotIndex   int
	Spec        GenerationSpecification
	References  []ReferenceMaterial
}

type MediaAssetRepository interface {
	InsertMediaAsset(ctx context.Context, tx TxExecutor, formation MediaAssetFormation) (bool, error)
	ListVisible(ctx context.Context, owner UUID, filter AssetListFilter, cursor *CompoundCursor, limit int) ([]MediaAsset, *CompoundCursor, error)
	GetVisible(ctx context.Context, owner, id UUID) (MediaAsset, error)
	ListVisibleSiblings(ctx context.Context, owner, taskID UUID) ([]MediaAsset, error)
	GetPrivateOrigin(ctx context.Context, asset MediaAsset) (*AssetPrivateOrigin, error)
	SoftDelete(ctx context.Context, tx TxExecutor, actor, id UUID, admin bool) error
}

type RestrictionState string

const (
	RestrictionActive   RestrictionState = "active"
	RestrictionReleased RestrictionState = "released"
)
