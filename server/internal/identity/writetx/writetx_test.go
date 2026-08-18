package writetx

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

// The narrow double: it records begin/commit/rollback and answers the
// identity observation deterministically, which real PostgreSQL cannot do for
// failure injection. Only the methods the runner touches are implemented; the
// embedded pgx.Tx makes any other use panic in the test.
type stubPool struct {
	beginErr error
	tx       *stubTx
}

func (p *stubPool) Begin(context.Context) (pgx.Tx, error) {
	if p.beginErr != nil {
		return nil, p.beginErr
	}
	return p.tx, nil
}

type stubTx struct {
	pgx.Tx
	sessionUser, currentUser string
	observeErr               error
	commitErr                error
	rollbackErr              error
	commits                  int
	rollbacks                int
}

func (t *stubTx) QueryRow(context.Context, string, ...any) pgx.Row {
	return stubRow{sessionUser: t.sessionUser, currentUser: t.currentUser, err: t.observeErr}
}

func (t *stubTx) Commit(context.Context) error {
	t.commits++
	return t.commitErr
}

func (t *stubTx) Rollback(context.Context) error {
	t.rollbacks++
	return t.rollbackErr
}

type stubRow struct {
	sessionUser, currentUser string
	err                      error
}

func (r stubRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*(dest[0].(*string)) = r.sessionUser
	*(dest[1].(*string)) = r.currentUser
	return nil
}

func identityAppTx() *stubTx {
	return &stubTx{sessionUser: identityAppRole, currentUser: identityAppRole}
}

func runnerFor(tx *stubTx) *Runner {
	return &Runner{pool: &stubPool{tx: tx}}
}

func TestRunCommitsSuccessfulCallback(t *testing.T) {
	tx := identityAppTx()
	invoked := 0
	if err := runnerFor(tx).Run(context.Background(), func(pgx.Tx) error {
		invoked++
		return nil
	}); err != nil {
		t.Fatalf("successful callback: %v", err)
	}
	if invoked != 1 {
		t.Fatalf("callback invoked %d times, want exactly once", invoked)
	}
	if tx.commits != 1 || tx.rollbacks != 0 {
		t.Fatalf("commits=%d rollbacks=%d, want one commit and no rollback", tx.commits, tx.rollbacks)
	}
}

func TestRunRollsBackCallbackError(t *testing.T) {
	tx := identityAppTx()
	cause := errors.New("business failure")
	err := runnerFor(tx).Run(context.Background(), func(pgx.Tx) error { return cause })
	if !errors.Is(err, cause) {
		t.Fatalf("callback error not preserved: %v", err)
	}
	if tx.commits != 0 || tx.rollbacks != 1 {
		t.Fatalf("commits=%d rollbacks=%d, want one rollback and no commit", tx.commits, tx.rollbacks)
	}
}

func TestRunNeverReplaysCallback(t *testing.T) {
	tx := identityAppTx()
	invoked := 0
	_ = runnerFor(tx).Run(context.Background(), func(pgx.Tx) error {
		invoked++
		return errors.New("transient")
	})
	if invoked != 1 {
		t.Fatalf("callback replayed %d times; the runner must never retry", invoked)
	}
}

func TestRunPreventsCommitAfterCancellation(t *testing.T) {
	tx := identityAppTx()
	ctx, cancel := context.WithCancel(context.Background())
	// The callback swallows the cancellation, so only the runner's completion
	// check stands between an abandoned operation and a durable write.
	cancel()
	err := runnerFor(tx).Run(ctx, func(pgx.Tx) error { return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled run: %v, want the context error", err)
	}
	if tx.commits != 0 || tx.rollbacks != 1 {
		t.Fatalf("commits=%d rollbacks=%d, want one rollback and no commit", tx.commits, tx.rollbacks)
	}
}

func TestRunRollsBackPanicAndPropagatesIt(t *testing.T) {
	tx := identityAppTx()
	panicked := false
	func() {
		defer func() {
			if r := recover(); r != nil {
				panicked = true
			}
		}()
		_ = runnerFor(tx).Run(context.Background(), func(pgx.Tx) error {
			panic("programming fault")
		})
	}()
	if !panicked {
		t.Fatal("panic was swallowed")
	}
	if tx.commits != 0 || tx.rollbacks != 1 {
		t.Fatalf("commits=%d rollbacks=%d, want best-effort rollback and no commit", tx.commits, tx.rollbacks)
	}
}

// A rollback failure during panic cleanup must not hide the panic: the
// diagnostic is logged by invoke and the programming fault stays observable.
func TestRunKeepsPanicWhenPanicRollbackFails(t *testing.T) {
	tx := identityAppTx()
	tx.rollbackErr = errors.New("rollback failed")
	panicked := false
	func() {
		defer func() {
			if r := recover(); r != nil {
				panicked = r == "programming fault"
			}
		}()
		_ = runnerFor(tx).Run(context.Background(), func(pgx.Tx) error {
			panic("programming fault")
		})
	}()
	if !panicked {
		t.Fatal("rollback failure replaced the original panic")
	}
	if tx.commits != 0 {
		t.Fatalf("commits=%d, want no commit on the panic path", tx.commits)
	}
}

func TestRunReturnsCommitFailure(t *testing.T) {
	tx := identityAppTx()
	tx.commitErr = errors.New("commit failed")
	err := runnerFor(tx).Run(context.Background(), func(pgx.Tx) error { return nil })
	if err == nil || !errors.Is(err, tx.commitErr) {
		t.Fatalf("commit failure not returned: %v", err)
	}
	if tx.rollbacks != 0 {
		t.Fatalf("rollbacks=%d, want none after a decided commit", tx.rollbacks)
	}
}

func TestRunKeepsRollbackFailureSecondary(t *testing.T) {
	tx := identityAppTx()
	tx.rollbackErr = errors.New("rollback failed")
	cause := errors.New("business failure")
	err := runnerFor(tx).Run(context.Background(), func(pgx.Tx) error { return cause })
	if !errors.Is(err, cause) {
		t.Fatalf("primary failure hidden by rollback failure: %v", err)
	}
	if !errors.Is(err, tx.rollbackErr) {
		t.Fatalf("rollback diagnostic dropped: %v", err)
	}
}

func TestRunRejectsUnexpectedIdentityWithoutInvokingCallback(t *testing.T) {
	for name, tc := range map[string]*stubTx{
		"owner authentication":               {sessionUser: "postgres", currentUser: "postgres"},
		"assumed role keeps authentication":  {sessionUser: "postgres", currentUser: identityAppRole},
		"execution role drifts from session": {sessionUser: identityAppRole, currentUser: "postgres"},
	} {
		invoked := false
		err := runnerFor(tc).Run(context.Background(), func(pgx.Tx) error {
			invoked = true
			return nil
		})
		if !errors.Is(err, ErrUnexpectedDatabaseIdentity) {
			t.Fatalf("%s: wrong error: %v", name, err)
		}
		if invoked {
			t.Fatalf("%s: business callback ran under a wrong identity", name)
		}
		if tc.commits != 0 || tc.rollbacks != 1 {
			t.Fatalf("%s: commits=%d rollbacks=%d, want fail-closed rollback", name, tc.commits, tc.rollbacks)
		}
	}
}

func TestRunReportsIdentityObservationFailureAsInfrastructureError(t *testing.T) {
	tx := identityAppTx()
	tx.observeErr = errors.New("connection reset")
	invoked := false
	err := runnerFor(tx).Run(context.Background(), func(pgx.Tx) error {
		invoked = true
		return nil
	})
	if !errors.Is(err, tx.observeErr) {
		t.Fatalf("observation failure not reported: %v", err)
	}
	if errors.Is(err, ErrUnexpectedDatabaseIdentity) {
		t.Fatalf("infrastructure failure misreported as identity mismatch: %v", err)
	}
	if invoked || tx.commits != 0 || tx.rollbacks != 1 {
		t.Fatalf("invoked=%v commits=%d rollbacks=%d, want no callback and one rollback", invoked, tx.commits, tx.rollbacks)
	}
}

func TestRunReportsBeginFailure(t *testing.T) {
	r := &Runner{pool: &stubPool{beginErr: errors.New("unreachable")}}
	err := r.Run(context.Background(), func(pgx.Tx) error { return nil })
	if err == nil || !errors.Is(err, r.pool.(*stubPool).beginErr) {
		t.Fatalf("begin failure not reported: %v", err)
	}
}

func TestVerifyStartupIdentityUsesTheTransactionPath(t *testing.T) {
	if err := runnerFor(identityAppTx()).VerifyStartupIdentity(context.Background()); err != nil {
		t.Fatalf("direct identity_app login rejected at startup: %v", err)
	}
	owner := &stubTx{sessionUser: "postgres", currentUser: "postgres"}
	if err := runnerFor(owner).VerifyStartupIdentity(context.Background()); !errors.Is(err, ErrUnexpectedDatabaseIdentity) {
		t.Fatalf("owner credential accepted at startup: %v", err)
	}
	if owner.commits != 0 || owner.rollbacks != 1 {
		t.Fatalf("commits=%d rollbacks=%d, want fail-closed rollback", owner.commits, owner.rollbacks)
	}
}
