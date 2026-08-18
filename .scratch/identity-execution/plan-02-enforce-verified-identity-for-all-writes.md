# Plan 02 — Enforce verified identity for all Identity writes

High-risk security-boundary change (runtime execution-identity enforcement).
Scope is ticket 02 only, on top of ticket 01's startup hardening and runtime
credential seam.

## Acceptance boundary

Every Organization, Membership, Invitation, Verification, and Outbox Worker
production write transaction runs through one Identity-local Write Transaction
Module (`server/internal/identity/writetx`). Each transaction begins, then
proves `session_user = current_user = identity_app` before the business
callback runs; a mismatch fails closed with no callback and no write. The
runner owns commit/rollback under the Lean V1 callback contract (`func(pgx.Tx)
error`): nil commits, error rolls back, cancellation before completion prevents
commit, panic performs best-effort rollback and propagates, commit failures are
returned, rollback failures stay secondary, and callbacks never replay.
Production components hold the runner instead of a pool, per-command
`SET LOCAL ROLE identity_app` statements disappear, and all existing command,
Audit Log, Outbox, SMTP, HTTP, and Desktop behavior is unchanged. No schema,
public contract, shared Server database layer, terminal state, or lifecycle
supervisor is introduced.

## Fixed point

`main` @ b979565 (branch cut: `feat/identity-write-transaction-boundary`).

## Primary Domain

Server Identity. Supporting: composition surface wiring in `module.go`
(runner handoff only), ADR-0008 amendment, `server/CONTEXT.md` vocabulary.

## Task-owned paths

- `server/internal/identity/writetx/` — new Write Transaction Module:
  `Runner` (`New(pool)`, `Run(ctx, fn)`, `VerifyStartupIdentity(ctx)`),
  `ErrUnexpectedDatabaseIdentity` sentinel (moved here, aliased in package
  `identity`), identity decision, narrow-double contract tests, opt-in
  real-role tests.
- `server/internal/identity/module.go` — construct the runner, verify startup
  identity through it, hand it to all components; alias sentinel.
- `server/internal/identity/organizations/`, `memberships/`, `invitations/`,
  `verification/`, `outbox/` — replace pool fields and per-command
  `begin`/`SET LOCAL ROLE` with runner callbacks; commit/rollback removed from
  business code.
- `server/internal/identity/execution_identity_test.go` — moves into `writetx`
  with the decision function.
- `docs/adr/0008-identity-write-boundary-and-rls-grant-structure.md` —
  amendment: per-transaction runner ownership, removal of role switching.
- `server/CONTEXT.md` — Write Transaction Module vocabulary; per-transaction
  note on the identity entries.
- `.scratch/identity-execution/issues/02-…` — ticket resolution.

## Key decisions

- Package named `writetx` (responsibility-named, Identity-local; not promoted
  to a shared layer). `Runner` holds an unexported `TxBeginner` interface
  satisfied by `*pgxpool.Pool`; in-package tests substitute a narrow double
  for deterministic begin/commit/rollback failure injection only. Real
  PostgreSQL roles remain the evidence for session_user/current_user
  semantics.
- Startup verification reuses the production path:
  `VerifyStartupIdentity` = `Run` with an empty callback (begin, verify,
  commit an empty transaction). One owner of the identity check; ticket 01's
  construction contract and sentinel semantics unchanged.
- Commit-decision rule: after a nil callback the runner checks `ctx.Err()`;
  canceled → rollback, otherwise commit on `context.WithoutCancel(ctx)`.
- Worker reconciliation: `deliverNext` invokes the runner with
  `context.WithoutCancel(ctx)` and enforces shutdown cancellation itself up to
  the send decision (claim and send use the real ctx; decided bookkeeping
  writes use the immune context). This preserves the existing
  mail-on-the-wire and genuine-failure commit semantics — no duplicate
  deliveries, no lost retry bookkeeping — while command paths keep the
  runner's cancellation rule.
- Invitation accept keeps its committed wrong-code bookkeeping: the callback
  records the attempt, returns nil (commit), and the public command error is
  reported from a captured variable after the runner returns — no Outcome
  protocol.
- Runtime mismatch stays per-transaction and redacted: the runner error wraps
  `ErrUnexpectedDatabaseIdentity` with expected-vs-observed roles (internal
  log visibility); the command pipeline's existing unmapped-error path logs it
  and answers the generic 500 envelope. No terminal state, no retries.

## Verification

- `cd server && go build ./... && go vet ./... && go test ./...` (writetx
  contract tests need no database).
- Real-stack identity integration via `./scripts/test-identity-integration.sh`
  — local Docker is unavailable on this host, so the PR's Identity Integration
  CI job on the identical tree is the binding evidence, watched per
  delivery.md before merge (same approach as ticket 01).
- Desktop E2E smoke on the PR (server paths change); label `full-e2e` since
  the ticket's acceptance names the Full E2E suite.
- code-review skill plus independent Go security review, ledger recorded,
  before landing.

## Out of scope

Per spec: Server-wide transaction abstraction, query-only capabilities,
Outcome protocol, callback retries, runtime ACL enumeration, credential
rotation, terminal Module state or process-exit policy, source-scanning
guards, Outbox protocol changes, schema/RLS changes, retention sweep.
