package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// noRowsErr adapts pgx's miss sentinel into the repositories' collapse rule.
var noRowsErr = pgx.ErrNoRows

// commandExecer is the statement-run surface a verified pgx transaction
// additionally exposes beyond domain.TxExecutor's QueryRow.
type commandExecer interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

// execTx runs one statement inside the caller's verified transaction and
// reports its affected-row count.
func execTx(tx domain.TxExecutor, ctx context.Context, sql string, args ...any) (int64, error) {
	commandTagger, ok := tx.(commandExecer)
	if !ok {
		return 0, errors.New("creation: transaction does not support Exec")
	}
	tag, err := commandTagger.Exec(ctx, sql, args...)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// cursorTime / cursorID project the optional compound keyset position into
// nullable SQL parameters.
func cursorTime(c *domain.CompoundCursor) *time.Time {
	if c == nil {
		return nil
	}
	t := c.CreatedAt.UTC()
	return &t
}

func cursorID(c *domain.CompoundCursor) *[16]byte {
	if c == nil {
		return nil
	}
	id := [16]byte(c.ID)
	return &id
}

// truncatePage drops the lookahead row once a page fills completely.
func truncatePage[T any](items []T, limit int) []T {
	if len(items) > limit {
		return items[:limit]
	}
	return items
}

// nextCursor derives the continuation token from the final kept row when a
// lookahead row proved more pages exist; a short page is the last.
func nextCursor(fetched, limit int, at func(int) (time.Time, domain.UUID)) *domain.CompoundCursor {
	if fetched > limit {
		t, id := at(limit - 1)
		return &domain.CompoundCursor{CreatedAt: t, ID: id}
	}
	return nil
}
