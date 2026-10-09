package postgres

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nevix-ai/server/internal/creation/domain"
)

// MaintenanceRepository persists the singleton admission fence and coherent task drain facts.
type MaintenanceRepository struct{ pool *pgxpool.Pool }

func NewMaintenanceRepository(pool *pgxpool.Pool) *MaintenanceRepository {
	return &MaintenanceRepository{pool: pool}
}

const maintenanceSnapshotSQL = `SELECT paused, owner_token, revision,
    (SELECT count(*) FROM creation_generation_tasks WHERE status IN ('queued','submitting','processing','persisting','cancelling'))
    FROM creation_maintenance WHERE singleton`

func scanMaintenance(row domain.Row) (domain.Maintenance, error) {
	var state domain.Maintenance
	err := row.Scan(&state.Paused, &state.OwnerToken, &state.Revision, &state.NonTerminalTasks)
	return state, err
}

func (r *MaintenanceRepository) Snapshot(ctx context.Context) (domain.Maintenance, error) {
	return scanMaintenance(r.pool.QueryRow(ctx, maintenanceSnapshotSQL))
}

func (r *MaintenanceRepository) SnapshotInTx(ctx context.Context, tx domain.TxExecutor) (domain.Maintenance, error) {
	return scanMaintenance(tx.QueryRow(ctx, maintenanceSnapshotSQL))
}

func (r *MaintenanceRepository) Lock(ctx context.Context, tx domain.TxExecutor) (domain.Maintenance, error) {
	var state domain.Maintenance
	err := tx.QueryRow(ctx, `SELECT paused, owner_token, revision FROM creation_maintenance WHERE singleton FOR UPDATE`).Scan(&state.Paused, &state.OwnerToken, &state.Revision)
	return state, err
}

func (r *MaintenanceRepository) Set(ctx context.Context, tx domain.TxExecutor, paused bool, owner domain.UUID) error {
	_, err := tx.Exec(ctx, `UPDATE creation_maintenance SET paused=$1, owner_token=$2, revision=revision+1 WHERE singleton`, paused, owner)
	return err
}

// The share lock survives until admission commits; pause waits for every earlier admission.
func (r *GenerationTaskRepository) RequireAdmissionOpen(ctx context.Context, tx domain.TxExecutor) error {
	var paused bool
	if err := tx.QueryRow(ctx, `SELECT paused FROM creation_maintenance WHERE singleton FOR SHARE`).Scan(&paused); err != nil {
		return err
	}
	if paused {
		return domain.ErrCreationMaintenance
	}
	return nil
}
