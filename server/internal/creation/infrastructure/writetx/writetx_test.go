package writetx

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/nevix-ai/server/internal/creation/domain"
)

type stubPool struct{ tx *stubTx }

func (p *stubPool) Begin(context.Context) (pgx.Tx, error) { return p.tx, nil }

type stubTx struct {
	pgx.Tx
	commitErr error
	commits   int
	rollbacks int
}

func (t *stubTx) QueryRow(context.Context, string, ...any) pgx.Row { return stubIdentityRow{} }
func (t *stubTx) Commit(context.Context) error {
	t.commits++
	return t.commitErr
}
func (t *stubTx) Rollback(context.Context) error {
	t.rollbacks++
	return nil
}

type stubIdentityRow struct{}

func (stubIdentityRow) Scan(dest ...any) error {
	*(dest[0].(*string)) = identityAppRole
	*(dest[1].(*string)) = identityAppRole
	return nil
}

func TestAfterCommitRunsAfterCommitInRegistrationOrder(t *testing.T) {
	tx := &stubTx{}
	runner := &Runner{pool: &stubPool{tx: tx}}
	var order []string
	commitsAtFirstEffect := 0
	err := runner.Run(context.Background(), func(sc domain.WriteScope) error {
		sc.AfterCommit(func() {
			commitsAtFirstEffect = tx.commits
			order = append(order, "first")
		})
		sc.AfterCommit(func() { order = append(order, "second") })
		return nil
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if commitsAtFirstEffect != 1 || len(order) != 2 || order[0] != "first" || order[1] != "second" {
		t.Fatalf("commit count at first effect=%d order=%v", commitsAtFirstEffect, order)
	}
}

func TestAfterCommitSkipsUncommittedPaths(t *testing.T) {
	tests := []struct {
		name         string
		callbackErr  error
		commitErr    error
		wantRollback int
	}{
		{name: "callback rollback", callbackErr: errors.New("callback failed"), wantRollback: 1},
		{name: "commit failure", commitErr: errors.New("commit failed")},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tx := &stubTx{commitErr: tc.commitErr}
			runner := &Runner{pool: &stubPool{tx: tx}}
			ran := false
			err := runner.Run(context.Background(), func(sc domain.WriteScope) error {
				sc.AfterCommit(func() { ran = true })
				return tc.callbackErr
			})
			if err == nil {
				t.Fatal("uncommitted path returned nil")
			}
			if ran || tx.rollbacks != tc.wantRollback {
				t.Fatalf("effect ran=%v rollbacks=%d, want false/%d", ran, tx.rollbacks, tc.wantRollback)
			}
		})
	}
}
