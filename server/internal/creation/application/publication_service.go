package application

import (
	"context"
	"time"
	"unicode/utf8"

	"github.com/nevix-ai/server/internal/auditlog"
	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/domain"
)

type PublicationCapabilities struct {
	CanWithdraw      bool
	CanCreateSimilar bool
	CanRestrict      bool
	CanRelease       bool
}

type PublicationView struct {
	Publication  domain.TeamPublication
	Capabilities PublicationCapabilities
}

type PublicationDetail struct {
	Publication PublicationView
	References  []domain.PublicationReference
}

type InspirationItem struct {
	Type        string
	Asset       *AssetView
	Publication *PublicationView
}

type AdminAssetDetail struct {
	Asset         AssetView
	Specification domain.GenerationSpecification
	References    []domain.PublicationReference
	Publication   *PublicationView
}

type PublicationService struct {
	repository domain.PublicationRepository
	runner     domain.WriteRunner
	storage    *ObjectStorageConnectionService
	manifest   *ManifestService
}

func NewPublicationService(repository domain.PublicationRepository, runner domain.WriteRunner, storage *ObjectStorageConnectionService, manifest *ManifestService) *PublicationService {
	return &PublicationService{repository: repository, runner: runner, storage: storage, manifest: manifest}
}

func (s *PublicationService) Publish(ctx context.Context, principal authz.Principal, assetID domain.UUID, key string) (PublicationView, bool, error) {
	actor, err := actorID(principal)
	if err != nil {
		return PublicationView{}, false, err
	}
	if !validIdempotencyKey(key) {
		return PublicationView{}, false, domain.ErrInvalidIdempotencyKey
	}
	var publication domain.TeamPublication
	var created bool
	err = s.runner.Run(ctx, func(scope domain.WriteScope) error {
		var commandErr error
		publication, created, commandErr = s.repository.Publish(ctx, scope.Tx(), actor, assetID, key)
		return commandErr
	})
	return publicationView(publication, actor, principal.Role == "admin"), created, err
}

func (s *PublicationService) ListInspiration(ctx context.Context, principal authz.Principal, filter domain.AssetListFilter, cursor *domain.CompoundCursor, limit int) ([]InspirationItem, *domain.CompoundCursor, error) {
	actor, err := actorID(principal)
	if err != nil {
		return nil, nil, err
	}
	admin := principal.Role == "admin"
	items, next, err := s.repository.ListInspiration(ctx, admin, filter, cursor, limit)
	if err != nil {
		return nil, nil, err
	}
	views := make([]InspirationItem, 0, len(items))
	for _, item := range items {
		view := InspirationItem{Type: item.Type}
		if item.Asset != nil {
			asset := assetView(*item.Asset, actor, true)
			asset.Capabilities.CanPublish = false
			asset.Capabilities.CanCreateSimilar = item.Asset.ActivePublication != nil &&
				item.Asset.ActivePublication.RestrictionState == "" &&
				item.Asset.RestrictionState != domain.RestrictionActive
			view.Asset = &asset
		}
		if item.Publication != nil {
			publication := publicationView(*item.Publication, actor, admin)
			view.Publication = &publication
		}
		views = append(views, view)
	}
	return views, next, nil
}

func (s *PublicationService) GetPublication(ctx context.Context, principal authz.Principal, id domain.UUID) (PublicationDetail, error) {
	actor, err := actorID(principal)
	if err != nil {
		return PublicationDetail{}, err
	}
	detail, err := s.repository.GetPublication(ctx, id)
	if err != nil {
		return PublicationDetail{}, err
	}
	return PublicationDetail{
		Publication: publicationView(detail.Publication, actor, principal.Role == "admin"),
		References:  detail.References,
	}, nil
}

func (s *PublicationService) GetAdminAsset(ctx context.Context, principal authz.Principal, id domain.UUID) (AdminAssetDetail, error) {
	actor, err := actorID(principal)
	if err != nil || principal.Role != "admin" {
		return AdminAssetDetail{}, domain.ErrAssetNotFound
	}
	detail, err := s.repository.GetAdminAsset(ctx, id)
	if err != nil {
		return AdminAssetDetail{}, err
	}
	asset := assetView(detail.Asset, actor, true)
	asset.Capabilities.CanPublish = false
	asset.Capabilities.CanCreateSimilar = detail.ActivePublication != nil &&
		detail.ActivePublication.RestrictionState == "" &&
		detail.Asset.RestrictionState != domain.RestrictionActive
	result := AdminAssetDetail{Asset: asset, Specification: detail.Specification, References: detail.References}
	if detail.ActivePublication != nil {
		publication := publicationView(*detail.ActivePublication, actor, true)
		result.Publication = &publication
	}
	return result, nil
}

func (s *PublicationService) ResolvePublication(ctx context.Context, principal authz.Principal, id domain.UUID) (domain.TeamPublication, error) {
	if _, err := actorID(principal); err != nil {
		return domain.TeamPublication{}, err
	}
	detail, err := s.repository.GetPublication(ctx, id)
	return detail.Publication, err
}

func (s *PublicationService) ResolveAdminAsset(ctx context.Context, principal authz.Principal, id domain.UUID) (domain.MediaAsset, error) {
	if principal.Role != "admin" {
		return domain.MediaAsset{}, domain.ErrAssetNotFound
	}
	detail, err := s.repository.GetAdminAsset(ctx, id)
	return detail.Asset, err
}

func (s *PublicationService) Withdraw(ctx context.Context, principal authz.Principal, id domain.UUID) error {
	actor, err := actorID(principal)
	if err != nil {
		return err
	}
	return s.runner.Run(ctx, func(scope domain.WriteScope) error {
		return s.repository.Withdraw(ctx, scope.Tx(), actor, id, principal.Role == "admin")
	})
}

func (s *PublicationService) RestrictAsset(ctx context.Context, principal authz.Principal, id domain.UUID) (AssetView, error) {
	return s.setAssetRestriction(ctx, principal, id, true)
}

func (s *PublicationService) ReleaseAsset(ctx context.Context, principal authz.Principal, id domain.UUID) (AssetView, error) {
	return s.setAssetRestriction(ctx, principal, id, false)
}

func (s *PublicationService) setAssetRestriction(ctx context.Context, principal authz.Principal, id domain.UUID, active bool) (AssetView, error) {
	actor, err := actorID(principal)
	if err != nil || principal.Role != "admin" {
		return AssetView{}, domain.ErrAssetNotFound
	}
	var asset domain.MediaAsset
	err = s.runner.Run(ctx, func(scope domain.WriteScope) error {
		var changed bool
		var commandErr error
		if active {
			asset, changed, commandErr = s.repository.RestrictAsset(ctx, scope.Tx(), id)
		} else {
			asset, changed, commandErr = s.repository.ReleaseAsset(ctx, scope.Tx(), id)
		}
		if commandErr != nil || !changed {
			return commandErr
		}
		action := auditlog.MediaAssetRestrictionReleased
		state := domain.RestrictionReleased
		if active {
			action = auditlog.MediaAssetRestricted
			state = domain.RestrictionActive
		}
		return appendRestrictionAudit(ctx, scope.Tx(), principal, action, "media_asset", id, state)
	})
	return assetView(asset, actor, true), err
}

func (s *PublicationService) RestrictPublication(ctx context.Context, principal authz.Principal, id domain.UUID) (PublicationView, error) {
	return s.setPublicationRestriction(ctx, principal, id, true)
}

func (s *PublicationService) ReleasePublication(ctx context.Context, principal authz.Principal, id domain.UUID) (PublicationView, error) {
	return s.setPublicationRestriction(ctx, principal, id, false)
}

func (s *PublicationService) setPublicationRestriction(ctx context.Context, principal authz.Principal, id domain.UUID, active bool) (PublicationView, error) {
	actor, err := actorID(principal)
	if err != nil || principal.Role != "admin" {
		return PublicationView{}, domain.ErrPublicationNotFound
	}
	var publication domain.TeamPublication
	err = s.runner.Run(ctx, func(scope domain.WriteScope) error {
		var changed bool
		var commandErr error
		if active {
			publication, changed, commandErr = s.repository.RestrictPublication(ctx, scope.Tx(), id)
		} else {
			publication, changed, commandErr = s.repository.ReleasePublication(ctx, scope.Tx(), id)
		}
		if commandErr != nil || !changed {
			return commandErr
		}
		action := auditlog.TeamPublicationRestrictionReleased
		state := domain.RestrictionReleased
		if active {
			action = auditlog.TeamPublicationRestricted
			state = domain.RestrictionActive
		}
		return appendRestrictionAudit(ctx, scope.Tx(), principal, action, "team_publication", id, state)
	})
	return publicationView(publication, actor, true), err
}

func appendRestrictionAudit(ctx context.Context, tx domain.TxExecutor, principal authz.Principal, action auditlog.Action, kind string, id domain.UUID, state domain.RestrictionState) error {
	actor, err := auditlog.SnapshotSubject(ctx, tx, principal.UserID)
	if err != nil {
		return err
	}
	return auditlog.Append(ctx, tx, auditlog.Entry{Actor: actor, Action: action, Metadata: map[string]string{
		"resource_kind": kind, "resource_id": id.String(), "restriction_state": string(state),
	}})
}

func (s *PublicationService) CreateSimilar(ctx context.Context, principal authz.Principal, id domain.UUID, key string) (domain.SimilarCreation, bool, error) {
	actor, err := actorID(principal)
	if err != nil {
		return domain.SimilarCreation{}, false, err
	}
	if !validIdempotencyKey(key) {
		return domain.SimilarCreation{}, false, domain.ErrInvalidIdempotencyKey
	}
	var result domain.SimilarCreation
	var created bool
	err = s.runner.Run(ctx, func(scope domain.WriteScope) error {
		var commandErr error
		result, created, commandErr = s.repository.CreateSimilar(ctx, scope.Tx(), actor, id, key)
		return commandErr
	})
	if err != nil {
		return domain.SimilarCreation{}, false, err
	}
	manifest, err := s.manifest.CapabilityManifest(ctx)
	if err != nil {
		return domain.SimilarCreation{}, false, err
	}
	result.SubmissionBlocked = !specificationFitsManifest(result.Specification, manifest)
	return result, created, nil
}

func (s *PublicationService) AuthorizePublicationPreview(ctx context.Context, publicationID, referenceID domain.UUID) (MaterialURLAuthorization, error) {
	reference, err := s.repository.GetPublicationReference(ctx, publicationID, referenceID)
	return s.authorizeReference(ctx, reference, err)
}

func (s *PublicationService) AuthorizeAdminAssetPreview(ctx context.Context, assetID, referenceID domain.UUID) (MaterialURLAuthorization, error) {
	reference, err := s.repository.GetAdminAssetReference(ctx, assetID, referenceID)
	return s.authorizeReference(ctx, reference, err)
}

func (s *PublicationService) authorizeReference(ctx context.Context, reference domain.PublicationReference, err error) (MaterialURLAuthorization, error) {
	if err != nil {
		return MaterialURLAuthorization{}, err
	}
	store, _, err := s.storage.ResolveStore(ctx)
	if err != nil {
		return MaterialURLAuthorization{}, err
	}
	url, err := store.PresignPreview(ctx, reference.BlobKey, reference.Kind, materialURLLifetime)
	if err != nil {
		return MaterialURLAuthorization{}, domain.ErrObjectStorageUnavailable
	}
	now := time.Now().UTC()
	return MaterialURLAuthorization{URL: url, ExpiresAt: now.Add(materialURLLifetime)}, nil
}

func publicationView(publication domain.TeamPublication, actor domain.UUID, admin bool) PublicationView {
	return PublicationView{
		Publication: publication,
		Capabilities: PublicationCapabilities{
			CanWithdraw:      publication.PublisherID == actor || admin,
			CanCreateSimilar: publication.RestrictionState == "",
			CanRestrict:      admin && publication.DirectRestriction != domain.RestrictionActive,
			CanRelease:       admin && publication.DirectRestriction == domain.RestrictionActive,
		},
	}
}

func actorID(principal authz.Principal) (domain.UUID, error) {
	return domain.ParseUUID(principal.UserID)
}

func validIdempotencyKey(key string) bool {
	count := utf8.RuneCountInString(key)
	return count >= 1 && count <= 128
}

func specificationFitsManifest(spec domain.GenerationSpecification, manifest domain.CapabilityManifestView) bool {
	media := domain.DraftMediaType(spec.MediaType)
	model, mode := spec.Model, spec.Mode
	quantity := spec.Quantity
	intent := &domain.GenerationIntent{
		Prompt: spec.Prompt, MediaType: &media, ManifestVersion: spec.ManifestVersion,
		Model: &model, Mode: &mode, Ratio: spec.Ratio, Resolution: spec.Resolution,
		Quantity: &quantity, DurationSeconds: spec.DurationSeconds,
	}
	for _, reference := range spec.References {
		intent.References = append(intent.References, domain.DraftReference{MaterialID: reference.MaterialID, Role: reference.Role})
	}
	_, err := freezeSpecification(intent, manifest)
	return err == nil
}
