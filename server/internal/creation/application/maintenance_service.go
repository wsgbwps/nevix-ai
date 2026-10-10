package application

import (
	"context"
	"strconv"

	"github.com/nevix-ai/server/internal/auditlog"
	"github.com/nevix-ai/server/internal/authz"
	"github.com/nevix-ai/server/internal/creation/domain"
)

// MaintenanceService owns persistent, audited, operation-scoped admission pause transitions.
type MaintenanceService struct {
	repository domain.MaintenanceRepository
	runner     domain.WriteRunner
}

func NewMaintenanceService(repository domain.MaintenanceRepository, runner domain.WriteRunner) *MaintenanceService {
	return &MaintenanceService{repository: repository, runner: runner}
}

func (s *MaintenanceService) Snapshot(ctx context.Context) (domain.Maintenance, error) {
	return s.repository.Snapshot(ctx)
}

func (s *MaintenanceService) Change(ctx context.Context, principal authz.Principal, paused bool, owner domain.UUID, expected int64) (domain.Maintenance, error) {
	var result domain.Maintenance
	err := s.runner.Run(ctx, func(sc domain.WriteScope) error {
		state, err := s.repository.Lock(ctx, sc.Tx())
		if err != nil {
			return err
		}
		owned := state.OwnerToken != nil && *state.OwnerToken == owner
		// Exact retries return the committed transition, including a lost HTTP response.
		if !(state.Paused == paused && owned && state.Revision-1 == expected) {
			if state.Revision != expected || state.Paused == paused || (!paused && !owned) {
				return domain.ErrMaintenanceRevisionConflict
			}
			if err := s.repository.Set(ctx, sc.Tx(), paused, owner); err != nil {
				return err
			}
			actor, err := auditlog.SnapshotSubject(ctx, sc.Tx(), principal.UserID)
			if err != nil {
				return err
			}
			action := auditlog.CreationMaintenanceResumed
			if paused {
				action = auditlog.CreationMaintenancePaused
			}
			if err := auditlog.Append(ctx, sc.Tx(), auditlog.Entry{Actor: actor, Action: action, Metadata: map[string]string{"revision": strconv.FormatInt(state.Revision+1, 10)}}); err != nil {
				return err
			}
		}
		result, err = s.repository.SnapshotInTx(ctx, sc.Tx())
		return err
	})
	return result, err
}
