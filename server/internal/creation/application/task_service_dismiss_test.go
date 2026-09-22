package application

import (
	"context"
	"errors"
	"testing"

	"github.com/nevix-ai/server/internal/creation/domain"
)

type dismissTaskRepoStub struct {
	domain.GenerationTaskRepository
	dismissed bool
}

func (r dismissTaskRepoStub) Dismiss(context.Context, domain.TxExecutor, domain.UUID, domain.UUID) (bool, error) {
	return r.dismissed, nil
}

// dismissalAssetRepoStub refuses exactly the ids its refused map names, the way
// the real SoftDelete's non-admin guard does.
type dismissalAssetRepoStub struct {
	domain.MediaAssetRepository
	assets   []domain.TaskAsset
	refused  map[domain.UUID]error
	deleted  []domain.UUID
	listCall bool
}

func (r *dismissalAssetRepoStub) ListTaskAssets(context.Context, domain.TxExecutor, domain.UUID, domain.UUID) ([]domain.TaskAsset, error) {
	r.listCall = true
	return r.assets, nil
}

func (r *dismissalAssetRepoStub) SoftDelete(_ context.Context, _ domain.TxExecutor, _, id domain.UUID, admin bool) (domain.UUID, error) {
	if admin {
		return domain.UUID{}, errors.New("task deletion must never take the admin delete path")
	}
	if err := r.refused[id]; err != nil {
		return domain.UUID{}, err
	}
	r.deleted = append(r.deleted, id)
	return domain.UUID{}, nil
}

// A result the deletion cannot remove is reported, never fatal: the restricted
// skip is the outcome ADR-0022 asks for, and it leaves the task deletion
// successful with the creator's own invalidation.
func TestTaskServiceDismissReportsResultsItCannotRemove(t *testing.T) {
	owner, taskID := domain.NewUUID(), domain.NewUUID()
	removedID, restrictedID, goneID := domain.NewUUID(), domain.NewUUID(), domain.NewUUID()
	assets := &dismissalAssetRepoStub{
		assets: []domain.TaskAsset{
			{ID: removedID, SlotIndex: 0},
			{ID: restrictedID, SlotIndex: 1, Restricted: true},
			{ID: goneID, SlotIndex: 2},
		},
		refused: map[domain.UUID]error{
			restrictedID: domain.ErrAssetNotFound,
			goneID:       domain.ErrAssetNotFound,
		},
	}
	sink := &recordingSink{}
	service := &TaskService{
		tasks:  dismissTaskRepoStub{dismissed: true},
		assets: assets,
		runner: assetRunnerStub{},
		notify: sink,
	}

	result, err := service.Dismiss(context.Background(), owner, taskID)
	if err != nil {
		t.Fatalf("dismiss: %v", err)
	}
	if len(result.RemovedSlotIndexes) != 1 || result.RemovedSlotIndexes[0] != 0 {
		t.Fatalf("removed slot indexes = %v, want [0]", result.RemovedSlotIndexes)
	}
	if len(result.Skipped) != 2 ||
		result.Skipped[0] != (DismissalSkip{SlotIndex: 1, Reason: domain.DismissalRestricted}) ||
		result.Skipped[1] != (DismissalSkip{SlotIndex: 2, Reason: domain.DismissalAlreadyRemoved}) {
		t.Fatalf("skipped = %+v", result.Skipped)
	}
	if len(assets.deleted) != 1 || assets.deleted[0] != removedID {
		t.Fatalf("deleted = %v, want the one removable result", assets.deleted)
	}
	if len(sink.owners) != 1 || sink.owners[0] != owner {
		t.Fatalf("dismiss published %v, want exactly the task owner %s", sink.owners, owner)
	}
}

// A target the repo's guard refuses — another member's task, an already
// dismissed one, or one still owing work — is the same 404, and no result is
// touched on the way out.
func TestTaskServiceDismissStopsBeforeResultsWhenTheTaskIsNotDismissable(t *testing.T) {
	assets := &dismissalAssetRepoStub{}
	service := &TaskService{tasks: dismissTaskRepoStub{}, assets: assets, runner: assetRunnerStub{}}

	if _, err := service.Dismiss(context.Background(), domain.NewUUID(), domain.NewUUID()); !errors.Is(err, domain.ErrTaskNotFound) {
		t.Fatalf("dismiss error = %v, want ErrTaskNotFound", err)
	}
	if assets.listCall {
		t.Fatal("a rejected task read its results anyway")
	}
}
