package domain

import (
	"cmp"
	"context"
	"slices"
	"strconv"
	"strings"
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
	CreatedUntil *time.Time
	Sort         AssetSort
	Search       string
	// Modes, Ratios and Resolutions constrain the frozen Generation
	// Specification of the Asset's Generation Task. Empty means unconstrained;
	// the parser admits only AcceptedAssetFacets values.
	Modes       []string
	Ratios      []string
	Resolutions []string
}

// AssetFacetVocabulary is one media's filter vocabulary: the values a frozen Generation
// Specification can carry, derived from the same source-controlled contract the manifest
// publishes, so the library's facets and the composer's pickers can never disagree.
type AssetFacetVocabulary struct {
	Modes       []string
	Ratios      []string
	Resolutions []string
}

// AssetFacets returns one media's filter vocabulary. Resolution tiers are model-scoped on the wire,
// so the union is published in first-seen tier order; "adaptive" is not a ratio row because those
// Assets are matched by their pixel shape instead.
func AssetFacets(media MediaType) AssetFacetVocabulary {
	models, modes, ratios := imageModels, imageModes, imageRatios
	if media == MediaVideo {
		models, modes, ratios = videoModels, videoModes, videoRatios
	}
	resolutions := make([]string, 0, len(models))
	for _, model := range models {
		for _, resolution := range model.Resolutions {
			if !slices.Contains(resolutions, resolution) {
				resolutions = append(resolutions, resolution)
			}
		}
	}
	expressible := make([]string, 0, len(ratios))
	for _, ratio := range ratios {
		if _, _, ok := RatioBounds(ratio); ok {
			expressible = append(expressible, ratio)
		}
	}
	// Widest first, so the picker reads the same way in both medias and the
	// client never has to re-order a published vocabulary.
	slices.SortStableFunc(expressible, func(left, right string) int {
		first, _ := ratioValue(left)
		second, _ := ratioValue(right)
		return cmp.Compare(second, first)
	})
	return AssetFacetVocabulary{
		Modes:       append([]string(nil), modes...),
		Ratios:      expressible,
		Resolutions: resolutions,
	}
}

// AcceptedAssetFacets is the union across both medias: what the filter admits with no
// media to scope by. A value legal for one media is always legal to ask for, and a
// combination matching nothing returns an empty page rather than a rejection.
func AcceptedAssetFacets() AssetFacetVocabulary {
	image, video := AssetFacets(MediaImage), AssetFacets(MediaVideo)
	return AssetFacetVocabulary{
		Modes:       unionValues(image.Modes, video.Modes),
		Ratios:      unionValues(image.Ratios, video.Ratios),
		Resolutions: unionValues(image.Resolutions, video.Resolutions),
	}
}

func unionValues(first, second []string) []string {
	merged := append([]string(nil), first...)
	for _, value := range second {
		if !slices.Contains(merged, value) {
			merged = append(merged, value)
		}
	}
	return merged
}

// RatioShapeTolerance is the relative margin on either side of a canonical ratio: a
// shape is that ratio while it stays within ±3% of it. Calibrated from the published
// size table: the largest gap between a label and its pixels is 1.84% (base 4K 16:9 is
// 5504x3040, i.e. 172:95) and the closest adjacent pair is 4:3 -> 3:2 at 12.5%, so 3%
// clears the deviation with room to spare and can never sort one shape into two rows.
const RatioShapeTolerance = 0.03

// RatioBounds returns the pixel-shape interval (width/height) that counts as
// ratio ("w:h"), or false for a value that is not an expressible ratio — the
// video sentinel "adaptive" among them.
func RatioBounds(ratio string) (float64, float64, bool) {
	value, ok := ratioValue(ratio)
	if !ok {
		return 0, 0, false
	}
	return value * (1 - RatioShapeTolerance), value * (1 + RatioShapeTolerance), true
}

func ratioValue(ratio string) (float64, bool) {
	width, height, found := strings.Cut(ratio, ":")
	if !found {
		return 0, false
	}
	w, wErr := strconv.Atoi(strings.TrimSpace(width))
	h, hErr := strconv.Atoi(strings.TrimSpace(height))
	if wErr != nil || hErr != nil || w <= 0 || h <= 0 {
		return 0, false
	}
	return float64(w) / float64(h), true
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
	// SoftDelete reports the deleted row's owner so an admin's delete invalidates
	// the creator's workbench, not the admin's.
	SoftDelete(ctx context.Context, tx TxExecutor, actor, id UUID, admin bool) (UUID, error)
}

type RestrictionState string

const (
	RestrictionActive   RestrictionState = "active"
	RestrictionReleased RestrictionState = "released"
)
