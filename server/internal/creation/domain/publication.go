package domain

import (
	"context"
	"time"
)

type TeamPublication struct {
	ID                   UUID
	SourceAssetID        UUID
	PublisherID          UUID
	PublisherDisplayName string
	MediaType            MediaType
	Mime                 string
	ByteSize             int64
	Checksum             []byte
	BlobKey              string
	WidthPx              *int
	HeightPx             *int
	DurationMS           *int
	Specification        GenerationSpecification
	PublishedAt          time.Time
	Restricted           bool
	RestrictionState     RestrictionState
	DirectRestriction    RestrictionState
}

type PublicationReference struct {
	ID             UUID
	PublicationID  UUID
	Position       int
	Role           DraftRole
	Kind           Kind
	FileName       string
	MimeType       string
	ByteSize       int64
	ChecksumSHA256 []byte
	BlobKey        string
	WidthPx        *int
	HeightPx       *int
	PixelCount     *int64
	DurationMS     *int
	ClaimsVersion  int
}

type PublicationDetail struct {
	Publication TeamPublication
	References  []PublicationReference
}

type AdminAssetDetail struct {
	Asset             MediaAsset
	Specification     GenerationSpecification
	References        []PublicationReference
	ActivePublication *TeamPublication
}

type InspirationItem struct {
	Type        string
	Asset       *MediaAsset
	Publication *TeamPublication
}

type SimilarCreation struct {
	Session           Session
	Materials         []ReferenceMaterial
	Specification     GenerationSpecification
	SubmissionBlocked bool
}

type PublicationRepository interface {
	Publish(ctx context.Context, tx TxExecutor, publisher, assetID UUID, idempotencyKey string) (TeamPublication, bool, error)
	ListInspiration(ctx context.Context, admin bool, filter AssetListFilter, cursor *CompoundCursor, limit int) ([]InspirationItem, *CompoundCursor, error)
	GetPublication(ctx context.Context, id UUID) (PublicationDetail, error)
	GetAdminAsset(ctx context.Context, id UUID) (AdminAssetDetail, error)
	Withdraw(ctx context.Context, tx TxExecutor, actor, id UUID, admin bool) error
	CreateSimilar(ctx context.Context, tx TxExecutor, actor, id UUID, idempotencyKey string) (SimilarCreation, bool, error)
	GetPublicationReference(ctx context.Context, publicationID, referenceID UUID) (PublicationReference, error)
	GetAdminAssetReference(ctx context.Context, assetID, referenceID UUID) (PublicationReference, error)
	RestrictAsset(ctx context.Context, tx TxExecutor, id UUID) (MediaAsset, bool, error)
	ReleaseAsset(ctx context.Context, tx TxExecutor, id UUID) (MediaAsset, bool, error)
	RestrictPublication(ctx context.Context, tx TxExecutor, id UUID) (TeamPublication, bool, error)
	ReleasePublication(ctx context.Context, tx TxExecutor, id UUID) (TeamPublication, bool, error)
}
