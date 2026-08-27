// Package postgres implements the Creation repositories over PostgreSQL.
// Every query carries creator-scoped predicates itself — ownership and
// logical deletion are decided by SQL, not by hoping callers remember them —
// and every cursor stays a compound keyset so deep pages never decay the way
// OFFSET does.
package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// SessionRepository reads off the pool and writes through caller-provided
// verified transactions.
type SessionRepository struct {
	pool *pgxpool.Pool
}

func NewSessionRepository(pool *pgxpool.Pool) *SessionRepository {
	return &SessionRepository{pool: pool}
}

const sessionColumns = "id, name, created_at, updated_at"

// Create inserts one session inside the provided write transaction.
func (r *SessionRepository) Create(ctx context.Context, tx domain.TxExecutor, owner domain.UUID, name string) (domain.Session, error) {
	row := tx.QueryRow(ctx,
		`INSERT INTO creation_sessions (owner_user_id, name) VALUES ($1, $2) RETURNING `+sessionColumns,
		owner, name)
	var s domain.Session
	if err := row.Scan(&s.ID, &s.Name, &s.CreatedAt, &s.UpdatedAt); err != nil {
		return domain.Session{}, fmt.Errorf("creation: insert session: %w", err)
	}
	s.OwnerID = owner
	return s, nil
}

// Get resolves one active session for its owner; any miss collapses into
// ErrSessionNotFound without distinguishing absence from foreign ownership.
func (r *SessionRepository) Get(ctx context.Context, owner, id domain.UUID) (domain.Session, error) {
	row := r.pool.QueryRow(ctx,
		`SELECT `+sessionColumns+`, owner_user_id FROM creation_sessions WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
		id, owner)
	return scanSession(row)
}

// List pages active sessions newest-first under the compound keyset.
func (r *SessionRepository) List(ctx context.Context, owner domain.UUID, cursor *domain.CompoundCursor, limit int) ([]domain.Session, *domain.CompoundCursor, error) {
	args := []any{owner, cursorTime(cursor), cursorID(cursor), limit + 1}
	rows, err := r.pool.Query(ctx, `
		SELECT `+sessionColumns+` FROM creation_sessions
		WHERE owner_user_id = $1 AND deleted_at IS NULL
		  AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
		ORDER BY created_at DESC, id DESC
		LIMIT $4`, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("creation: list sessions: %w", err)
	}
	defer rows.Close()
	sessions := make([]domain.Session, 0, limit)
	for rows.Next() {
		var s domain.Session
		if err := rows.Scan(&s.ID, &s.Name, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, nil, fmt.Errorf("creation: scan session row: %w", err)
		}
		s.OwnerID = owner
		sessions = append(sessions, s)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("creation: list sessions rows: %w", err)
	}
	next := nextCursor(len(sessions), limit, func(i int) (time.Time, domain.UUID) {
		return sessions[i].CreatedAt, sessions[i].ID
	})
	sessions = truncatePage(sessions, limit)
	return sessions, next, nil
}

// Rename updates only an active owned session inside the write transaction.
func (r *SessionRepository) Rename(ctx context.Context, tx domain.TxExecutor, owner, id domain.UUID, name string) (domain.Session, error) {
	row := tx.QueryRow(ctx,
		`UPDATE creation_sessions SET name = $3, updated_at = now()
		 WHERE id = $2 AND owner_user_id = $1 AND deleted_at IS NULL
		 RETURNING `+sessionColumns,
		owner, id, name)
	s, err := scanSessionRow(row)
	if errors.Is(err, noRowsErr) {
		return domain.Session{}, domain.ErrSessionNotFound
	}
	return s, err
}

// Delete soft-deletes; repeating it observes nothing to delete, per contract.
func (r *SessionRepository) Delete(ctx context.Context, tx domain.TxExecutor, owner, id domain.UUID) error {
	tag, err := execTx(tx, ctx, `
		UPDATE creation_sessions SET deleted_at = now(), updated_at = now()
		WHERE id = $2 AND owner_user_id = $1 AND deleted_at IS NULL`,
		owner, id)
	if err != nil {
		return fmt.Errorf("creation: delete session: %w", err)
	}
	if tag == 0 {
		return domain.ErrSessionNotFound
	}
	return nil
}

type rowScanner interface{ Scan(dest ...any) error }

// scanSession adapts QueryRow results carrying a trailing owner column.
func scanSession(row rowScanner) (domain.Session, error) {
	var s domain.Session
	err := row.Scan(&s.ID, &s.Name, &s.CreatedAt, &s.UpdatedAt, &s.OwnerID)
	if errors.Is(err, noRowsErr) {
		return domain.Session{}, domain.ErrSessionNotFound
	}
	if err != nil {
		return domain.Session{}, fmt.Errorf("creation: get session: %w", err)
	}
	return s, nil
}

func scanSessionRow(row rowScanner) (domain.Session, error) {
	var s domain.Session
	err := row.Scan(&s.ID, &s.Name, &s.CreatedAt, &s.UpdatedAt)
	if errors.Is(err, noRowsErr) {
		return domain.Session{}, domain.ErrSessionNotFound
	}
	if err != nil {
		return domain.Session{}, fmt.Errorf("creation: session write: %w", err)
	}
	return s, nil
}
