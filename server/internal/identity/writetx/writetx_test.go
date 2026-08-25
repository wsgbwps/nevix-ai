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
	if err := runnerFor(tx).Run(context.Background(), func(*Scope) error {
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
	err := runnerFor(tx).Run(context.Background(), func(*Scope) error { return cause })
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
	_ = runnerFor(tx).Run(context.Background(), func(*Scope) error {
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
	err := runnerFor(tx).Run(ctx, func(*Scope) error { return nil })
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
		_ = runnerFor(tx).Run(context.Background(), func(*Scope) error {
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
		_ = runnerFor(tx).Run(context.Background(), func(*Scope) error {
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
	err := runnerFor(tx).Run(context.Background(), func(*Scope) error { return nil })
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
	err := runnerFor(tx).Run(context.Background(), func(*Scope) error { return cause })
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
		err := runnerFor(tc).Run(context.Background(), func(*Scope) error {
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
	err := runnerFor(tx).Run(context.Background(), func(*Scope) error {
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
	err := r.Run(context.Background(), func(*Scope) error { return nil })
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

// The scope is the callback's only view of an in-flight write transaction:
// the callback reads the active transaction from it, and the transaction
// contract (here: nil commits) is unchanged behind the narrower parameter.
func TestRunExposesTheActiveTransactionThroughScope(t *testing.T) {
	tx := identityAppTx()
	var observed pgx.Tx
	if err := runnerFor(tx).Run(context.Background(), func(sc *Scope) error {
		observed = sc.Tx()
		return nil
	}); err != nil {
		t.Fatalf("scoped callback: %v", err)
	}
	if observed == nil || observed != pgx.Tx(tx) {
		t.Fatal("scope did not hand back the active transaction")
	}
}

// AfterCommit effects are the durable-state trigger: each runs exactly
// once, in registration order, on the commit path — and by the time the
// first one runs, the commit decision has already been made.
func TestRunExecutesAfterCommitEffectsOnceInRegistrationOrder(t *testing.T) {
	tx := identityAppTx()
	var order []string
	commitsAtFirstEffect := -1
	if err := runnerFor(tx).Run(context.Background(), func(sc *Scope) error {
		sc.AfterCommit(func() {
			if commitsAtFirstEffect < 0 {
				commitsAtFirstEffect = tx.commits
			}
			order = append(order, "first")
		})
		sc.AfterCommit(func() { order = append(order, "second") })
		sc.AfterCommit(func() { order = append(order, "third") })
		return nil
	}); err != nil {
		t.Fatalf("successful callback: %v", err)
	}
	if len(order) != 3 || order[0] != "first" || order[1] != "second" || order[2] != "third" {
		t.Fatalf("effects ran as %v, want first,second,third each exactly once", order)
	}
	if commitsAtFirstEffect != 1 {
		t.Fatalf("first effect observed commits=%d, want 1: effects must run after the commit decision", commitsAtFirstEffect)
	}
}

// A callback error rolls the transaction back and leaves every registered
// effect unexecuted: no durable state, no trigger.
func TestRunSkipsAfterCommitEffectsOnCallbackError(t *testing.T) {
	tx := identityAppTx()
	var ran int
	err := runnerFor(tx).Run(context.Background(), func(sc *Scope) error {
		sc.AfterCommit(func() { ran++ })
		return errors.New("business failure")
	})
	if err == nil {
		t.Fatal("callback error was swallowed")
	}
	if ran != 0 {
		t.Fatalf("effects ran %d times on the rollback path", ran)
	}
	if tx.commits != 0 || tx.rollbacks != 1 {
		t.Fatalf("commits=%d rollbacks=%d, want one rollback and no commit", tx.commits, tx.rollbacks)
	}
}

// Cancellation observed when the callback completes prevents the commit;
// the abandonment path must not fire effects either.
func TestRunSkipsAfterCommitEffectsOnCancellationBeforeCommit(t *testing.T) {
	tx := identityAppTx()
	ctx, cancel := context.WithCancel(context.Background())
	var ran int
	cancel()
	err := runnerFor(tx).Run(ctx, func(sc *Scope) error {
		sc.AfterCommit(func() { ran++ })
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled run: %v, want the context error", err)
	}
	if ran != 0 || tx.commits != 0 || tx.rollbacks != 1 {
		t.Fatalf("ran=%d commits=%d rollbacks=%d, want no effect and fail-closed rollback", ran, tx.commits, tx.rollbacks)
	}
}

// A callback panic triggers best-effort rollback and propagates; effects
// never run — the panic path owns the outcome before any commit decision.
func TestRunSkipsAfterCommitEffectsOnCallbackPanic(t *testing.T) {
	tx := identityAppTx()
	var ran int
	func() {
		defer func() { _ = recover() }()
		_ = runnerFor(tx).Run(context.Background(), func(sc *Scope) error {
			sc.AfterCommit(func() { ran++ })
			panic("programming fault")
		})
	}()
	if ran != 0 || tx.commits != 0 || tx.rollbacks != 1 {
		t.Fatalf("ran=%d commits=%d rollbacks=%d, want no effect, rollback, no commit", ran, tx.commits, tx.rollbacks)
	}
}

// A commit failure leaves durability undecided; effects must not run —
// their premise (committed state) was never established.
func TestRunSkipsAfterCommitEffectsOnCommitFailure(t *testing.T) {
	tx := identityAppTx()
	tx.commitErr = errors.New("commit failed")
	var ran int
	err := runnerFor(tx).Run(context.Background(), func(sc *Scope) error {
		sc.AfterCommit(func() { ran++ })
		return nil
	})
	if err == nil || !errors.Is(err, tx.commitErr) {
		t.Fatalf("commit failure not returned: %v", err)
	}
	if ran != 0 {
		t.Fatalf("effects ran %d times after a failed commit", ran)
	}
}

// An execution-identity rejection never invokes the callback, so nothing
// can be registered and no effect exists to run.
func TestRunSkipsAfterCommitEffectsOnUnexpectedIdentity(t *testing.T) {
	owner := &stubTx{sessionUser: "postgres", currentUser: "postgres"}
	var ran int
	err := runnerFor(owner).Run(context.Background(), func(sc *Scope) error {
		sc.AfterCommit(func() { ran++ })
		return nil
	})
	if !errors.Is(err, ErrUnexpectedDatabaseIdentity) {
		t.Fatalf("wrong identity accepted: %v", err)
	}
	if ran != 0 || owner.commits != 0 || owner.rollbacks != 1 {
		t.Fatalf("ran=%d commits=%d rollbacks=%d, want no effect and fail-closed rollback", ran, owner.commits, owner.rollbacks)
	}
}

// An effect panic is a programming fault in post-commit work: the commit
// already stands, the panic propagates unchanged, and the effects after the
// panicking one do not run.
func TestRunPropagatesAfterCommitEffectPanic(t *testing.T) {
	tx := identityAppTx()
	var ran int
	recovered := any(nil)
	func() {
		defer func() { recovered = recover() }()
		_ = runnerFor(tx).Run(context.Background(), func(sc *Scope) error {
			sc.AfterCommit(func() { panic("effect fault") })
			sc.AfterCommit(func() { ran++ })
			return nil
		})
	}()
	if recovered != "effect fault" {
		t.Fatalf("effect panic was swallowed or altered: %v", recovered)
	}
	if ran != 0 {
		t.Fatal("an effect registered after the panicking one ran")
	}
	if tx.commits != 1 || tx.rollbacks != 0 {
		t.Fatalf("commits=%d rollbacks=%d, want the committed state to stand", tx.commits, tx.rollbacks)
	}
}
