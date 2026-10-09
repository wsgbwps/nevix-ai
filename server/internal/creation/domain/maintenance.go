package domain

import (
	"context"
	"errors"
)

var (
	ErrCreationMaintenance         = errors.New("creation admission paused for maintenance")
	ErrMaintenanceRevisionConflict = errors.New("maintenance owner or revision changed")
)

// Maintenance is a coherent durable admission and drain snapshot.
type Maintenance struct {
	Paused           bool
	OwnerToken       *UUID
	Revision         int64
	NonTerminalTasks int64
}

type MaintenanceRepository interface {
	Snapshot(context.Context) (Maintenance, error)
	Lock(context.Context, TxExecutor) (Maintenance, error)
	Set(context.Context, TxExecutor, bool, UUID) error
	SnapshotInTx(context.Context, TxExecutor) (Maintenance, error)
}
