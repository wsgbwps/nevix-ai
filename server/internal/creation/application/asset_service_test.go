package application

import (
	"context"
	"errors"
	"testing"

	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/domain"
)

type assetRepoStub struct {
	asset       domain.MediaAsset
	origin      *domain.AssetPrivateOrigin
	originReads int
	deleteActor domain.UUID
	deleteID    domain.UUID
	deleteAdmin bool
	deleteCalls int
}

func (r *assetRepoStub) InsertMediaAsset(context.Context, domain.TxExecutor, domain.MediaAssetFormation) (bool, error) {
	return false, nil
}

func (r *assetRepoStub) ListVisible(context.Context, domain.UUID, domain.AssetListFilter, *domain.CompoundCursor, int) ([]domain.MediaAsset, *domain.CompoundCursor, error) {
	return []domain.MediaAsset{r.asset}, nil, nil
}

func (r *assetRepoStub) GetVisible(_ context.Context, owner, _ domain.UUID) (domain.MediaAsset, error) {
	if owner != r.asset.OwnerID {
		return domain.MediaAsset{}, domain.ErrAssetNotFound
	}
	return r.asset, nil
}

func (r *assetRepoStub) ListVisibleSiblings(context.Context, domain.UUID, domain.UUID) ([]domain.MediaAsset, error) {
	return []domain.MediaAsset{r.asset}, nil
}

func (r *assetRepoStub) GetPrivateOrigin(context.Context, domain.MediaAsset) (*domain.AssetPrivateOrigin, error) {
	r.originReads++
	return r.origin, nil
}

func (r *assetRepoStub) SoftDelete(_ context.Context, _ domain.TxExecutor, actor, id domain.UUID, admin bool) (domain.UUID, error) {
	r.deleteCalls++
	r.deleteActor, r.deleteID, r.deleteAdmin = actor, id, admin
	return r.asset.OwnerID, nil
}

type assetRunnerStub struct{ commitErr error }

func (r assetRunnerStub) Run(ctx context.Context, fn func(domain.WriteScope) error) error {
	scope := &assetWriteScopeStub{}
	if err := fn(scope); err != nil {
		return err
	}
	if r.commitErr != nil {
		return r.commitErr
	}
	scope.runEffects()
	return nil
}

type assetWriteScopeStub struct{ effects []func() }

func (s *assetWriteScopeStub) Tx() domain.TxExecutor     { return nil }
func (s *assetWriteScopeStub) AfterCommit(effect func()) { s.effects = append(s.effects, effect) }

func (s *assetWriteScopeStub) runEffects() {
	for _, effect := range s.effects {
		effect()
	}
}

type recordingSink struct{ owners []domain.UUID }

func (s *recordingSink) NotifyGenerationChanged(owner domain.UUID) {
	s.owners = append(s.owners, owner)
}

func TestAssetServiceKeepsPrivateOriginCreatorOnly(t *testing.T) {
	creator, other := domain.NewUUID(), domain.NewUUID()
	asset := domain.MediaAsset{ID: domain.NewUUID(), OwnerID: creator, TaskID: domain.NewUUID()}
	repo := &assetRepoStub{asset: asset, origin: &domain.AssetPrivateOrigin{TaskID: asset.TaskID}}
	service := NewAssetService(repo, assetRunnerStub{}, nil)

	creatorDetail, err := service.Get(context.Background(), authz.Principal{UserID: creator.String(), Role: "member"}, asset.ID)
	if err != nil || creatorDetail.PrivateOrigin == nil || !creatorDetail.Asset.Capabilities.CanCreateSimilar {
		t.Fatalf("creator detail = %+v, error=%v", creatorDetail, err)
	}
	otherDetail, err := service.Get(context.Background(), authz.Principal{UserID: other.String(), Role: "admin"}, asset.ID)
	if err != domain.ErrAssetNotFound || otherDetail.PrivateOrigin != nil {
		t.Fatalf("foreign admin detail = %+v, error=%v", otherDetail, err)
	}
	if repo.originReads != 1 {
		t.Fatalf("private origin reads=%d, want creator-only one read", repo.originReads)
	}
}

func TestAssetServicePassesDeleteIdentityToRepository(t *testing.T) {
	actor, owner, assetID := domain.NewUUID(), domain.NewUUID(), domain.NewUUID()
	repo := &assetRepoStub{asset: domain.MediaAsset{ID: assetID, OwnerID: owner}}
	sink := &recordingSink{}
	service := NewAssetService(repo, assetRunnerStub{}, sink)
	if err := service.Delete(context.Background(), authz.Principal{UserID: actor.String(), Role: "admin"}, assetID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if repo.deleteActor != actor || repo.deleteID != assetID || !repo.deleteAdmin {
		t.Fatalf("delete authorization not preserved: actor=%s id=%s admin=%v", repo.deleteActor, repo.deleteID, repo.deleteAdmin)
	}
	if len(sink.owners) != 1 || sink.owners[0] != owner {
		t.Fatalf("delete published %v, want exactly the asset owner %s", sink.owners, owner)
	}
}

func TestAssetServiceSkipsInvalidationWhenTheWriteTransactionFails(t *testing.T) {
	owner, assetID := domain.NewUUID(), domain.NewUUID()
	repo := &assetRepoStub{asset: domain.MediaAsset{ID: assetID, OwnerID: owner}}
	sink := &recordingSink{}
	service := NewAssetService(repo, assetRunnerStub{commitErr: errors.New("commit failed")}, sink)
	if err := service.Delete(context.Background(), authz.Principal{UserID: owner.String(), Role: "member"}, assetID); err == nil {
		t.Fatal("delete: want the failed transaction reported")
	}
	if len(sink.owners) != 0 {
		t.Fatalf("failed delete published %v, want nothing", sink.owners)
	}
}

func TestAssetViewOmitsReleasedPublicationWhenRepublishingIsAllowed(t *testing.T) {
	owner := domain.NewUUID()
	asset := domain.MediaAsset{
		OwnerID: owner,
		ActivePublication: &domain.TeamPublication{
			ID:               domain.NewUUID(),
			RestrictionState: domain.RestrictionReleased,
		},
	}

	view := assetView(asset, owner, false)

	if !view.Capabilities.CanPublish {
		t.Fatal("released publication must allow a fresh publication")
	}
	if view.Asset.ActivePublication != nil {
		t.Fatal("released terminal publication must not be advertised as active")
	}
}

func TestAssetServiceRejectsForeignMemberBeforeWrite(t *testing.T) {
	owner, actor, assetID := domain.NewUUID(), domain.NewUUID(), domain.NewUUID()
	repo := &assetRepoStub{asset: domain.MediaAsset{ID: assetID, OwnerID: owner}}
	service := NewAssetService(repo, assetRunnerStub{}, nil)
	if err := service.Delete(context.Background(), authz.Principal{UserID: actor.String(), Role: "member"}, assetID); err != domain.ErrAssetNotFound {
		t.Fatalf("foreign member delete error=%v, want ErrAssetNotFound", err)
	}
	if repo.deleteCalls != 0 {
		t.Fatalf("foreign member reached write repository %d time(s)", repo.deleteCalls)
	}
}
