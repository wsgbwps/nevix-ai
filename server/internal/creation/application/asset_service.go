package application

import (
	"context"
	"time"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/domain"
)

type AssetCapabilities struct {
	CanDelete        bool
	CanCreateSimilar bool
	CanPublish       bool
	CanRestrict      bool
	CanRelease       bool
}

type AssetView struct {
	Asset        domain.MediaAsset
	Capabilities AssetCapabilities
}

type AssetDetail struct {
	Asset         AssetView
	Siblings      []AssetView
	PrivateOrigin *domain.AssetPrivateOrigin
}

type AssetService struct {
	assets  domain.MediaAssetRepository
	storage *ObjectStorageConnectionService
	runner  domain.WriteRunner
	notify  InvalidationSink
}

func NewAssetService(assets domain.MediaAssetRepository, storage *ObjectStorageConnectionService, runner domain.WriteRunner, notify InvalidationSink) *AssetService {
	return &AssetService{assets: assets, storage: storage, runner: runner, notify: notify}
}

func (s *AssetService) List(ctx context.Context, principal authz.Principal, filter domain.AssetListFilter, cursor *domain.CompoundCursor, limit int) ([]AssetView, *domain.CompoundCursor, error) {
	actor, err := domain.ParseUUID(principal.UserID)
	if err != nil {
		return nil, nil, err
	}
	assets, next, err := s.assets.ListVisible(ctx, actor, filter, cursor, limit)
	if err != nil {
		return nil, nil, err
	}
	return assetViews(assets, actor, false), next, nil
}

func (s *AssetService) Get(ctx context.Context, principal authz.Principal, id domain.UUID) (AssetDetail, error) {
	actor, err := domain.ParseUUID(principal.UserID)
	if err != nil {
		return AssetDetail{}, err
	}
	asset, err := s.assets.GetVisible(ctx, actor, id)
	if err != nil {
		return AssetDetail{}, err
	}
	siblings, err := s.assets.ListVisibleSiblings(ctx, actor, asset.TaskID)
	if err != nil {
		return AssetDetail{}, err
	}
	detail := AssetDetail{
		Asset:    assetView(asset, actor, false),
		Siblings: assetViews(siblings, actor, false),
	}
	if asset.OwnerID == actor {
		detail.PrivateOrigin, err = s.assets.GetPrivateOrigin(ctx, asset)
		if err != nil {
			return AssetDetail{}, err
		}
	}
	return detail, nil
}

func (s *AssetService) Resolve(ctx context.Context, principal authz.Principal, id domain.UUID) (domain.MediaAsset, error) {
	actor, err := domain.ParseUUID(principal.UserID)
	if err != nil {
		return domain.MediaAsset{}, err
	}
	asset, err := s.assets.GetVisible(ctx, actor, id)
	if err != nil {
		return domain.MediaAsset{}, err
	}
	return asset, nil
}

// AuthorizeThumbnail issues the signed GET of one visible Asset's fixed wall
// variant. Video ids collapse into not_found, so a guessed id learns nothing
// about whether it exists.
func (s *AssetService) AuthorizeThumbnail(ctx context.Context, principal authz.Principal, id domain.UUID) (DisplayURLAuthorization, error) {
	asset, err := s.Resolve(ctx, principal, id)
	if err != nil {
		return DisplayURLAuthorization{}, err
	}
	if asset.MediaType != domain.MediaImage {
		return DisplayURLAuthorization{}, domain.ErrAssetNotFound
	}
	store, _, err := s.storage.ResolveStore(ctx)
	if err != nil {
		return DisplayURLAuthorization{}, err
	}
	signedURL, err := store.PresignThumbnail(ctx, asset.BlobKey, displayURLLifetime)
	if err != nil {
		return DisplayURLAuthorization{}, domain.ErrObjectStorageUnavailable
	}
	return DisplayURLAuthorization{URL: signedURL, ExpiresAt: time.Now().UTC().Add(displayURLLifetime)}, nil
}

// AuthorizePreview issues the signed GET of one visible Asset's detail
// variant: images provider-resized, video as its untouched original so
// Chromium keeps Range and seek.
func (s *AssetService) AuthorizePreview(ctx context.Context, principal authz.Principal, id domain.UUID) (DisplayURLAuthorization, error) {
	asset, err := s.Resolve(ctx, principal, id)
	if err != nil {
		return DisplayURLAuthorization{}, err
	}
	store, _, err := s.storage.ResolveStore(ctx)
	if err != nil {
		return DisplayURLAuthorization{}, err
	}
	signedURL, err := store.PresignPreview(ctx, asset.BlobKey, asset.MediaType.Kind(), displayURLLifetime)
	if err != nil {
		return DisplayURLAuthorization{}, domain.ErrObjectStorageUnavailable
	}
	return DisplayURLAuthorization{URL: signedURL, ExpiresAt: time.Now().UTC().Add(displayURLLifetime)}, nil
}

func (s *AssetService) Delete(ctx context.Context, principal authz.Principal, id domain.UUID) error {
	actor, err := domain.ParseUUID(principal.UserID)
	if err != nil {
		return err
	}
	admin := principal.Role == "admin"
	if !admin {
		if _, err := s.assets.GetVisible(ctx, actor, id); err != nil {
			return err
		}
	}
	return s.runner.Run(ctx, func(sc domain.WriteScope) error {
		owner, err := s.assets.SoftDelete(ctx, sc.Tx(), actor, id, admin)
		if err != nil {
			return err
		}
		notifyOwner(sc, s.notify, owner)
		return nil
	})
}

func assetViews(assets []domain.MediaAsset, actor domain.UUID, admin bool) []AssetView {
	views := make([]AssetView, 0, len(assets))
	for _, asset := range assets {
		views = append(views, assetView(asset, actor, admin))
	}
	return views
}

func assetView(asset domain.MediaAsset, actor domain.UUID, admin bool) AssetView {
	owner := asset.OwnerID == actor
	canPublish := owner && asset.RestrictionState != domain.RestrictionActive &&
		(asset.ActivePublication == nil || asset.ActivePublication.RestrictionState == domain.RestrictionReleased)
	if canPublish && asset.ActivePublication != nil {
		asset.ActivePublication = nil
	}
	return AssetView{
		Asset: asset,
		Capabilities: AssetCapabilities{
			CanDelete:        owner || admin,
			CanCreateSimilar: owner && asset.RestrictionState != domain.RestrictionActive,
			CanPublish:       canPublish,
			CanRestrict:      admin && asset.RestrictionState != domain.RestrictionActive,
			CanRelease:       admin && asset.RestrictionState == domain.RestrictionActive,
		},
	}
}
