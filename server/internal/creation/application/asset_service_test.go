package application

import (
	"context"
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

func (r *assetRepoStub) SoftDelete(_ context.Context, _ domain.TxExecutor, actor, id domain.UUID, admin bool) error {
	r.deleteCalls++
	r.deleteActor, r.deleteID, r.deleteAdmin = actor, id, admin
	return nil
}

type assetRunnerStub struct{}

func (assetRunnerStub) Run(ctx context.Context, fn func(domain.WriteScope) error) error {
	return fn(assetWriteScopeStub{})
}

type assetWriteScopeStub struct{}

func (assetWriteScopeStub) Tx() domain.TxExecutor { return nil }
func (assetWriteScopeStub) AfterCommit(func())    {}

func TestAssetServiceKeepsPrivateOriginCreatorOnly(t *testing.T) {
	creator, other := domain.NewUUID(), domain.NewUUID()
	asset := domain.MediaAsset{ID: domain.NewUUID(), OwnerID: creator, TaskID: domain.NewUUID()}
	repo := &assetRepoStub{asset: asset, origin: &domain.AssetPrivateOrigin{TaskID: asset.TaskID}}
	service := NewAssetService(repo, assetRunnerStub{})

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
	actor, assetID := domain.NewUUID(), domain.NewUUID()
	repo := &assetRepoStub{}
	service := NewAssetService(repo, assetRunnerStub{})
	if err := service.Delete(context.Background(), authz.Principal{UserID: actor.String(), Role: "admin"}, assetID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if repo.deleteActor != actor || repo.deleteID != assetID || !repo.deleteAdmin {
		t.Fatalf("delete authorization not preserved: actor=%s id=%s admin=%v", repo.deleteActor, repo.deleteID, repo.deleteAdmin)
	}
}

func TestAssetServiceRejectsForeignMemberBeforeWrite(t *testing.T) {
	owner, actor, assetID := domain.NewUUID(), domain.NewUUID(), domain.NewUUID()
	repo := &assetRepoStub{asset: domain.MediaAsset{ID: assetID, OwnerID: owner}}
	service := NewAssetService(repo, assetRunnerStub{})
	if err := service.Delete(context.Background(), authz.Principal{UserID: actor.String(), Role: "member"}, assetID); err != domain.ErrAssetNotFound {
		t.Fatalf("foreign member delete error=%v, want ErrAssetNotFound", err)
	}
	if repo.deleteCalls != 0 {
		t.Fatalf("foreign member reached write repository %d time(s)", repo.deleteCalls)
	}
}
