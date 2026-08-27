// Package writetx is the Creation Module's domain-local write transaction
// implementation (ADR-0016): the sole production entry point for every
// Creation-owned database write. It mirrors the Identity Write Transaction
// Module's discipline without importing it — begin, prove session_user and
// current_user are both exactly identity_app before any business work, then
// own commit and rollback under the callback contract: nil commits, anything
// else (including cancellation and panic) rolls back once and never replays
// the callback. AfterCommit effects run exactly once, in registration order,
// only on the committed path; external Storage I/O must be scheduled there,
// never inside a locked transaction.
package writetx

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nevix-ai/server/internal/creation/domain"
)

// identityAppRole is the only PostgreSQL role a Creation write transaction
// may run as. There is deliberately no per-domain second role (ADR-0014/0015).
const identityAppRole = "identity_app"

// ErrUnexpectedDatabaseIdentity reports that a database connection or
// transaction did not prove the expected identity_app execution identity.
var ErrUnexpectedDatabaseIdentity = errors.New("unexpected database identity")

// txBeginner is the single pool capability the runner needs. Package tests
// substitute a narrow double for deterministic failure injection.
type txBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Runner owns the Creation write-transaction lifecycle.
type Runner struct {
	pool txBeginner
}

// New builds the runner over the runtime pool, which must authenticate
// directly as identity_app.
func New(pool *pgxpool.Pool) *Runner {
	return &Runner{pool: pool}
}

// VerifyStartupIdentity is the construction-time round trip.
func (r *Runner) VerifyStartupIdentity(ctx context.Context) error {
	return r.Run(ctx, func(domain.WriteScope) error { return nil })
}

// compile-time proof that the runner satisfies the domain port.
var _ domain.WriteRunner = (*Runner)(nil)

// Scope is the narrow view of one in-flight write transaction that Run's
// callback works through: the active transaction plus after-commit effect
// registration. Begin, verification, commit, rollback, cancellation, and
// panic handling stay in the Runner.
type Scope struct {
	tx      pgx.Tx
	effects []func()
}

// Tx returns the active write transaction for statement execution.
func (s *Scope) Tx() pgx.Tx { return s.tx }

// runEffects drains registered effects in order on the committed path only.
func (s *Scope) runEffects() {
	for _, effect := range s.effects {
		effect()
	}
}

// AfterCommit registers one effect to run after the transaction commits
// successfully. Effects run exactly once each, in registration order, on the
// caller's goroutine; an effect needing a context captures its own because
// the request context may already be gone. Effects never run on any failure
// or rollback path.
func (s *Scope) AfterCommit(effect func()) {
	s.effects = append(s.effects, effect)
}

// Run executes fn exactly once inside a verified write transaction. See the
// package comment for the full lifecycle contract. The callback receives
// the domain write-scope view, keeping application layers off this package.
func (r *Runner) Run(ctx context.Context, fn func(domain.WriteScope) error) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("creation: begin write transaction: %w", err)
	}
	if err := verifyExecutionIdentity(ctx, tx); err != nil {
		return rollback(ctx, tx, err)
	}
	scope := &Scope{tx: tx}
	if err := invoke(ctx, tx, fn, scope); err != nil {
		return rollback(ctx, tx, err)
	}
	if err := ctx.Err(); err != nil {
		return rollback(ctx, tx, fmt.Errorf("creation: context canceled before commit: %w", err))
	}
	if err := tx.Commit(context.WithoutCancel(ctx)); err != nil {
		return fmt.Errorf("creation: commit write transaction: %w", err)
	}
	scope.runEffects()
	return nil
}

// invoke runs the callback so a panic still gets a best-effort rollback
// before the panic propagates unchanged.
func invoke(ctx context.Context, tx pgx.Tx, fn func(domain.WriteScope) error, scope *Scope) (err error) {
	defer func() {
		if p := recover(); p != nil {
			if rbErr := tx.Rollback(context.WithoutCancel(ctx)); rbErr != nil {
				slog.Error("creation: rollback after callback panic failed", "panic", p, "error", rbErr)
			}
			panic(p)
		}
	}()
	return fn(scope)
}

// rollback finalizes a failed transaction on a cancellation-immune context
// and keeps a rollback failure secondary to its cause.
func rollback(ctx context.Context, tx pgx.Tx, cause error) error {
	if err := tx.Rollback(context.WithoutCancel(ctx)); err != nil {
		return fmt.Errorf("%w; rollback also failed: %w", cause, err)
	}
	return cause
}

// verifyExecutionIdentity observes the transaction's authentication and
// execution identities and requires both to equal identity_app.
func verifyExecutionIdentity(ctx context.Context, tx pgx.Tx) error {
	var sessionUser, currentUser string
	if err := tx.QueryRow(ctx, "SELECT session_user, current_user").Scan(&sessionUser, &currentUser); err != nil {
		return fmt.Errorf("creation: verify write transaction identity: %w", err)
	}
	return unexpectedIdentityError(sessionUser, currentUser)
}

// unexpectedIdentityError records expected versus observed roles for
// operators without carrying any connection string or credential.
func unexpectedIdentityError(sessionUser, currentUser string) error {
	if sessionUser != identityAppRole || currentUser != identityAppRole {
		return fmt.Errorf("%w: runtime database connection must authenticate directly as %s, got session_user=%s current_user=%s",
			ErrUnexpectedDatabaseIdentity, identityAppRole, sessionUser, currentUser)
	}
	return nil
}
