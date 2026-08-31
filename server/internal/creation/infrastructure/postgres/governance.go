package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// GovernanceRepository implements the governance policy port. Every column
// is independently optional: NULL means unset (unlimited) and zero means
// explicitly forbidden — the distinction is the product contract.
type GovernanceRepository struct {
	pool *pgxpool.Pool
}

func NewGovernanceRepository(pool *pgxpool.Pool) *GovernanceRepository {
	return &GovernanceRepository{pool: pool}
}

// policyConflictTarget is the expression unique index both the instance row
// (user_id NULL) and user rows upsert against.
const policyConflictTarget = "COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)"

const policyColumns = `scope, user_id, image_concurrency, video_concurrency, rate_limit, monthly_task_limit`

func scanPolicyRow(row pgx.Row) (domain.GovernancePolicy, error) {
	var p domain.GovernancePolicy
	var scope string
	var userID *domain.UUID
	err := row.Scan(&scope, &userID, &p.ImageConcurrency, &p.VideoConcurrency, &p.RateLimit, &p.MonthlyTaskLimit)
	if err != nil {
		return domain.GovernancePolicy{}, err
	}
	p.Scope = domain.GovernanceScope(scope)
	p.UserID = userID
	return p, nil
}

// LoadPolicies resolves the instance row and all user overrides on the
// caller's transaction so admission evaluates one consistent snapshot.
func (r *GovernanceRepository) LoadPolicies(ctx context.Context, tx domain.TxExecutor) (*domain.GovernancePolicy, map[domain.UUID]domain.GovernancePolicy, error) {
	rows, err := tx.Query(ctx, `SELECT `+policyColumns+` FROM creation_generation_policies`)
	if err != nil {
		return nil, nil, fmt.Errorf("creation: load governance policies: %w", err)
	}
	defer rows.Close()
	var instance *domain.GovernancePolicy
	users := map[domain.UUID]domain.GovernancePolicy{}
	for rows.Next() {
		policy, err := scanPolicyRow(rows)
		if err != nil {
			return nil, nil, fmt.Errorf("creation: scan governance policy: %w", err)
		}
		if policy.Scope == domain.GovernanceScopeInstance {
			copied := policy
			instance = &copied
			continue
		}
		if policy.UserID != nil {
			users[*policy.UserID] = policy
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("creation: load governance policies rows: %w", err)
	}
	return instance, users, nil
}

// PutInstancePolicy upserts the single instance row (full-row replacement).
func (r *GovernanceRepository) PutInstancePolicy(ctx context.Context, tx domain.TxExecutor, policy domain.GovernancePolicy, updatedBy domain.UUID) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO creation_generation_policies (
			scope, user_id, image_concurrency, video_concurrency, rate_limit, monthly_task_limit, updated_by_user_id
		) VALUES ('instance', NULL, $1, $2, $3, $4, $5)
		ON CONFLICT (`+policyConflictTarget+`) DO UPDATE SET
			image_concurrency = EXCLUDED.image_concurrency,
			video_concurrency = EXCLUDED.video_concurrency,
			rate_limit = EXCLUDED.rate_limit,
			monthly_task_limit = EXCLUDED.monthly_task_limit,
			updated_by_user_id = EXCLUDED.updated_by_user_id,
			updated_at = now()`,
		policy.ImageConcurrency, policy.VideoConcurrency, policy.RateLimit, policy.MonthlyTaskLimit, updatedBy); err != nil {
		return fmt.Errorf("creation: put instance governance: %w", err)
	}
	return nil
}

// PutUserPolicy upserts one user's override row; a missing user surfaces as
// ErrGovernanceUserNotFound through the FK violation.
func (r *GovernanceRepository) PutUserPolicy(ctx context.Context, tx domain.TxExecutor, policy domain.GovernancePolicy, updatedBy domain.UUID) error {
	if _, err := tx.Exec(ctx, `
		INSERT INTO creation_generation_policies (
			scope, user_id, image_concurrency, video_concurrency, rate_limit, monthly_task_limit, updated_by_user_id
		) VALUES ('user', $1, $2, $3, $4, $5, $6)
		ON CONFLICT (`+policyConflictTarget+`) DO UPDATE SET
			image_concurrency = EXCLUDED.image_concurrency,
			video_concurrency = EXCLUDED.video_concurrency,
			rate_limit = EXCLUDED.rate_limit,
			monthly_task_limit = EXCLUDED.monthly_task_limit,
			updated_by_user_id = EXCLUDED.updated_by_user_id,
			updated_at = now()`,
		policy.UserID, policy.ImageConcurrency, policy.VideoConcurrency, policy.RateLimit,
		policy.MonthlyTaskLimit, updatedBy); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return domain.ErrGovernanceUserNotFound
		}
		return fmt.Errorf("creation: put user governance: %w", err)
	}
	return nil
}

// ListPolicies resolves every policy row for the admin view.
func (r *GovernanceRepository) ListPolicies(ctx context.Context) (*domain.GovernancePolicy, []domain.GovernancePolicy, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+policyColumns+` FROM creation_generation_policies ORDER BY user_id NULLS FIRST`)
	if err != nil {
		return nil, nil, fmt.Errorf("creation: list governance policies: %w", err)
	}
	defer rows.Close()
	var instance *domain.GovernancePolicy
	users := []domain.GovernancePolicy{}
	for rows.Next() {
		policy, err := scanPolicyRow(rows)
		if err != nil {
			return nil, nil, fmt.Errorf("creation: scan governance policy: %w", err)
		}
		if policy.Scope == domain.GovernanceScopeInstance {
			copied := policy
			instance = &copied
			continue
		}
		users = append(users, policy)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("creation: list governance policies rows: %w", err)
	}
	return instance, users, nil
}
