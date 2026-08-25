// Package writetx is the Identity Module's Write Transaction Module: the sole
// production entry point for every Identity-owned database write transaction.
// It begins the transaction, proves the PostgreSQL authentication identity
// (session_user) and execution identity (current_user) are both exactly
// identity_app before any business work runs, and then owns commit and
// rollback under the callback contract: a nil callback error commits, any
// other outcome rolls back, and a callback is never replayed. The callback
// receives a narrow Scope — the active transaction plus registration of
// after-commit effects — so a caller can participate in the transaction and
// schedule work its committed state should trigger, while every lifecycle
// decision (begin, verification, commit, rollback, cancellation, panic
// handling) stays here. The responsibility stays local to Identity; it is
// not a Server-wide database abstraction.
package writetx

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// identityAppRole is the only PostgreSQL role an Identity write transaction
// may run as: the fixed, least-privilege LOGIN role created by the Identity
// migrations.
const identityAppRole = "identity_app"

// ErrUnexpectedDatabaseIdentity reports that a database connection or
// transaction did not prove the expected identity_app execution identity. It
// is wrapped by construction and transaction errors and is never part of a
// public HTTP response; callers use it to distinguish a configuration failure
// from other database errors.
var ErrUnexpectedDatabaseIdentity = errors.New("unexpected database identity")

// txBeginner is the single pool capability the runner needs. Production
// supplies *pgxpool.Pool; in-package tests substitute a narrow double where
// deterministic begin/commit/rollback failure injection cannot be expressed
// reliably against PostgreSQL. Real PostgreSQL roles remain the evidence for
// session_user and current_user semantics.
type txBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Runner owns the Identity write-transaction lifecycle: begin, execution-
// identity verification, and finalization.
type Runner struct {
	pool txBeginner
}

// New builds the runner over the runtime pool. The pool must authenticate
// directly as identity_app; NewModule proves that once at startup through
// VerifyStartupIdentity, and Run re-proves it on every transaction.
func New(pool *pgxpool.Pool) *Runner {
	return &Runner{pool: pool}
}

// VerifyStartupIdentity is the construction-time round trip: it runs one
// empty write transaction, so a usable Module implies the pool could begin,
// prove session_user = current_user = identity_app, and finalize a
// transaction. An unreachable or failing database surfaces as a plain
// infrastructure error, distinct from ErrUnexpectedDatabaseIdentity.
func (r *Runner) VerifyStartupIdentity(ctx context.Context) error {
	return r.Run(ctx, func(*Scope) error { return nil })
}

// Scope is the narrow view of one in-flight Identity write transaction that
// Run's callback works through: the active transaction, plus registration of
// effects to run once that transaction commits. It is deliberately the only
// shape a caller sees of an unfinished transaction — the Runner keeps begin,
// execution-identity verification, commit, rollback, cancellation, and panic
// handling — so callers can participate in a write transaction and schedule
// commit-triggered work, but never finalize, retry, or nest one themselves.
type Scope struct {
	tx      pgx.Tx
	effects []func()
}

// Tx returns the active write transaction. Every database read and write the
// callback performs goes through it; helpers below the callback seam keep
// receiving pgx.Tx from here.
func (s *Scope) Tx() pgx.Tx { return s.tx }

// AfterCommit registers one effect to run after the transaction commits
// successfully. Effects run exactly once each, in registration order, on the
// caller's goroutine after the commit decision — so an effect may treat the
// transaction's writes as durable (a later pool read sees them) but must
// never assume the request context is still alive; a closure needing a
// context captures its own. Effects never run when the callback returns an
// error, cancellation prevents the commit, the callback panics, the
// transaction rolls back, or the commit itself fails. An effect failure
// cannot change the committed outcome: an effect panic propagates unchanged
// as a programming fault, and the effects registered after the panicking one
// do not run.
func (s *Scope) AfterCommit(effect func()) {
	s.effects = append(s.effects, effect)
}

// runEffects drains the registered effects in registration order. It runs
// only on the committed path, after tx.Commit succeeded.
func (s *Scope) runEffects() {
	for _, effect := range s.effects {
		effect()
	}
}

// Run executes fn exactly once inside a verified Identity write transaction:
// the transaction begins, session_user and current_user must both equal
// identity_app — otherwise fn is never invoked and the transaction rolls
// back, writing nothing — and finalization follows the callback's verdict.
// fn receives a Scope carrying the active transaction and the after-commit
// registrations it makes along the way; those effects run exactly once each,
// in registration order, only after the commit succeeds. fn returning nil
// requests commit; a nil callback, cancellation, or other error requests
// rollback and runs no effects. Cancellation observed when the callback
// completes prevents the commit; once the commit decision is reached with a
// valid context, finalization runs on a cancellation-immune context so a
// late cancel cannot turn a decided commit into an avoidable unknown
// result. A panic triggers best-effort rollback and remains a panic. Commit
// failures are returned — effects do not run, since their committed-state
// premise never held; rollback failures are kept as secondary diagnostics
// behind the primary failure. Run never retries fn.
func (r *Runner) Run(ctx context.Context, fn func(*Scope) error) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("identity: begin write transaction: %w", err)
	}
	if err := verifyExecutionIdentity(ctx, tx); err != nil {
		return rollback(ctx, tx, err)
	}
	scope := &Scope{tx: tx}
	if err := invoke(ctx, tx, fn, scope); err != nil {
		return rollback(ctx, tx, err)
	}
	if err := ctx.Err(); err != nil {
		return rollback(ctx, tx, fmt.Errorf("identity: context canceled before commit: %w", err))
	}
	if err := tx.Commit(context.WithoutCancel(ctx)); err != nil {
		return fmt.Errorf("identity: commit write transaction: %w", err)
	}
	scope.runEffects()
	return nil
}

// invoke runs the callback so a panic still gets a best-effort rollback
// before the panic propagates unchanged. A rollback failure here cannot be
// returned (the panic owns the outcome), so it is logged as the secondary
// diagnostic instead of being discarded.
func invoke(ctx context.Context, tx pgx.Tx, fn func(*Scope) error, scope *Scope) (err error) {
	defer func() {
		if p := recover(); p != nil {
			if err := tx.Rollback(context.WithoutCancel(ctx)); err != nil {
				slog.Error("identity: rollback after callback panic failed", "panic", p, "error", err)
			}
			panic(p)
		}
	}()
	return fn(scope)
}

// rollback finalizes a failed transaction on a cancellation-immune context
// and keeps a rollback failure secondary to the failure that caused it.
func rollback(ctx context.Context, tx pgx.Tx, cause error) error {
	if err := tx.Rollback(context.WithoutCancel(ctx)); err != nil {
		return fmt.Errorf("%w; rollback also failed: %w", cause, err)
	}
	return cause
}

// verifyExecutionIdentity observes the transaction's authentication and
// execution identities and requires both to equal identity_app. A failing
// observation is a plain infrastructure error, distinct from
// ErrUnexpectedDatabaseIdentity.
func verifyExecutionIdentity(ctx context.Context, tx pgx.Tx) error {
	var sessionUser, currentUser string
	if err := tx.QueryRow(ctx, "SELECT session_user, current_user").Scan(&sessionUser, &currentUser); err != nil {
		return fmt.Errorf("identity: verify write transaction identity: %w", err)
	}
	return unexpectedIdentityError(sessionUser, currentUser)
}

// unexpectedIdentityError is the identity decision, isolated so the two role
// checks are provable independently of a live database: the message records
// the expected versus observed roles for operators without carrying any
// connection string or credential.
func unexpectedIdentityError(sessionUser, currentUser string) error {
	if sessionUser != identityAppRole || currentUser != identityAppRole {
		return fmt.Errorf("%w: runtime database connection must authenticate directly as %s, got session_user=%s current_user=%s",
			ErrUnexpectedDatabaseIdentity, identityAppRole, sessionUser, currentUser)
	}
	return nil
}
