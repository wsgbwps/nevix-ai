# 02 — Enforce verified identity for all Identity writes

**What to build:** Route every Organization, Membership, Invitation, Verification, and Outbox Worker production write transaction through one Identity-local Write Transaction Module. The transaction must verify the PostgreSQL authentication and execution identities before business work, fail without writes when the invariant is violated, and preserve all existing command, Audit Log, Outbox, and SMTP behavior.

**Consumes:**

- Ticket 01's context-bearing Module construction contract.
- Ticket 01's directly authenticated runtime pool and owner fixture pool.
- Ticket 01's startup identity guarantee and database role evidence.
- Existing `pgx.Tx`-based business helpers.
- The current command pipeline's internal logging and public error redaction.
- The existing `RunWorkers` lifecycle.
- Existing integration behavior for all five write categories.

**Produces:**

- The final Identity-local Write Transaction Module.
- A Lean V1 callback contract based on `pgx.Tx` and `error`.
- Per-transaction checks of `session_user` and `current_user`.
- One production transaction entry for all five Identity write categories.
- Removal of production role switching and distributed raw transaction ownership.
- Complete architecture documentation for Identity transaction ownership.
- Unified security acceptance evidence across all five write categories.

**Owns:**

- The Write Transaction Module's sole internal public interface.
- Transaction begin, identity verification, commit, rollback, and error wrapping.
- Single callback execution, context cancellation, panic cleanup, commit failures, and rollback diagnostics.
- Transaction migration for Organization, Membership, Invitation, Verification, and Outbox Worker writes.
- Invitation verification failures that must commit attempt bookkeeping before returning a public command error.
- Outbox claim, SMTP, delivery, retry, and cancellation commit semantics.
- Internal recognizability and public redaction of runtime identity violations.
- It does not own terminal Module state, fatal channels, automatic callback retry, or a new Worker lifecycle.

**Blocked by:** 01 — Reject unexpected PostgreSQL identity at startup.

**Parallel classification:** Sequential atomic high-risk slice. It is not `parallel-ready`; before Ticket 01 completes, only read-only research or test sketching is safe partial parallel work.

**Status:** resolved

- [x] Organization, Membership, Invitation, Verification, and Outbox Worker production writes all use the same transaction runner.
- [x] Every transaction verifies `session_user = identity_app` and `current_user = identity_app` before invoking business work.
- [x] An identity mismatch does not invoke the callback and produces no database write.
- [x] Production command, Verification, and Worker components no longer retain a raw pool or begin their own transactions.
- [x] Production code no longer executes `SET LOCAL ROLE identity_app`.
- [x] A successful callback commits and an unsuccessful callback rolls back.
- [x] Context cancellation prevents a commit that has not reached its decision point.
- [x] Panic performs best-effort rollback and remains observable as a panic.
- [x] Commit errors remain failures, while rollback errors do not hide the primary failure.
- [x] The transaction runner never automatically replays a callback.
- [x] Invitation verification-attempt bookkeeping and its public error behavior remain unchanged.
- [x] Outbox claim, SMTP, retry, cancellation, delivered, and shutdown behavior remains unchanged.
- [x] Real integration paths pass for all five write categories.
- [x] Runtime identity failures use the existing generic public internal error without exposing database-role details.
- [x] `Register`, `RunWorkers`, HTTP payloads, and Desktop contracts remain unchanged.
- [x] No schema migration, shared database layer, terminal-state machine, or lifecycle supervisor is introduced.
- [x] Architecture documentation accurately records the complete transaction-ownership invariant.
- [x] Server, Identity, and Full E2E checks, independent Go security review, and final-state evidence pass for the complete boundary.

**Absence test:** If this ticket is never implemented, Ticket 01 remains a complete, independently releasable startup-hardening slice. If this ticket lands with no further candidates, the full Lean V1 specification is delivered; it has no undeclared follow-up dependency.

**Commutativity test:** The only valid merge order is Ticket 01 followed by Ticket 02. Reversing the order cannot preserve the startup contract or real integration and E2E evidence because the required Module and credential seams do not yet exist. This non-commutativity is the reason for the blocking edge.

## Comments

### Acceptance conclusion (2026-08-18)

Delivered on `feat/identity-write-transaction-boundary` against `main` @ b979565; ledger `.scratch/identity-execution/code-review-ledger-02.json` (closed: 1 full review + 1 targeted round, 1 accepted blocker repaired and closed, 2 advisories repaired in-batch; independent Go security review **PASS** with 1 low-severity advisory dispositioned below).

- `internal/identity/writetx` is the sole production entry for all five write categories: `Runner.Run` begins the transaction, proves `session_user` = `current_user` = `identity_app` before the business callback, and owns finalization — nil commits, error rolls back, cancellation observed at callback completion prevents commit (finalization then runs on `context.WithoutCancel`), panic best-effort rolls back (rollback failure logged) and propagates, commit failures returned, rollback failures secondary (`%w; rollback also failed: %w`), callbacks never replayed. `VerifyStartupIdentity` reuses the same path, so ticket 01's construction contract is unchanged; `identity.ErrUnexpectedDatabaseIdentity` aliases the sentinel that now lives in writetx.
- All components (`organizations`, `memberships`, `invitations`, `verification`, `outbox`) hold `*writetx.Runner` instead of a pool; per-command `SET LOCAL ROLE identity_app` statements and every production `Begin` outside writetx are gone. Invitation wrong-code attempt bookkeeping still commits before the public command error surfaces (captured `commandErr` reported after the transaction — no Outcome protocol). `deliverNext` runs the runner on `context.WithoutCancel(ctx)` and enforces shutdown itself up to the send decision, preserving claim/SMTP/retry/cancelled/delivered semantics: a delivered or genuinely failed row's bookkeeping commits even when shutdown raced the send, and a shutdown-canceled send rolls the row back to pending.
- Contract evidence: `writetx_test.go` proves commit/rollback/cancellation/panic/commit-failure/rollback-failure/no-replay/mismatch-without-callback with a narrow double; `runner_roles_integration_test.go` proves owner rejection (despite `pg_has_role … MEMBER`), assumed-role rejection, and direct-login acceptance with real PostgreSQL roles, executing inside the harness's checked invocation (`test-mail-smoke.sh` runs `./internal/identity/writetx` with a zero-skip sentinel and fail-fast `requireEnv` — the CR-SPEC-0001 repair).
- ADR-0008 gains the 写事务所有权 amendment and `server/CONTEXT.md` gains the Write Transaction Module vocabulary plus the per-transaction note on Execution Identity.
- Security-review advisory (deferred): the worker's cancellation-immune runner context also covers begin/identity observation, so a stalled PostgreSQL could delay shutdown by at most one poll transaction; accepted as a Lean V1 tradeoff because the old finalization path had the same unboundedness and making setup cancellable again would reintroduce the duplicate-delivery/lost-bookkeeping window the design exists to prevent (lifecycle supervision is an explicit non-goal).
- Local Docker was unavailable, so the real-stack legs (Identity Integration CI — including the new writetx role evidence — plus Desktop E2E smoke and the `full-e2e`-labeled Full E2E) run as PR CI on the identical tree and are watched before merge per delivery.md; local: `go build/vet/test` green across all 10 server packages, `bash -n` + `make harness-test` green.
