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

**Status:** ready-for-agent

- [ ] Organization, Membership, Invitation, Verification, and Outbox Worker production writes all use the same transaction runner.
- [ ] Every transaction verifies `session_user = identity_app` and `current_user = identity_app` before invoking business work.
- [ ] An identity mismatch does not invoke the callback and produces no database write.
- [ ] Production command, Verification, and Worker components no longer retain a raw pool or begin their own transactions.
- [ ] Production code no longer executes `SET LOCAL ROLE identity_app`.
- [ ] A successful callback commits and an unsuccessful callback rolls back.
- [ ] Context cancellation prevents a commit that has not reached its decision point.
- [ ] Panic performs best-effort rollback and remains observable as a panic.
- [ ] Commit errors remain failures, while rollback errors do not hide the primary failure.
- [ ] The transaction runner never automatically replays a callback.
- [ ] Invitation verification-attempt bookkeeping and its public error behavior remain unchanged.
- [ ] Outbox claim, SMTP, retry, cancellation, delivered, and shutdown behavior remains unchanged.
- [ ] Real integration paths pass for all five write categories.
- [ ] Runtime identity failures use the existing generic public internal error without exposing database-role details.
- [ ] `Register`, `RunWorkers`, HTTP payloads, and Desktop contracts remain unchanged.
- [ ] No schema migration, shared database layer, terminal-state machine, or lifecycle supervisor is introduced.
- [ ] Architecture documentation accurately records the complete transaction-ownership invariant.
- [ ] Server, Identity, and Full E2E checks, independent Go security review, and final-state evidence pass for the complete boundary.

**Absence test:** If this ticket is never implemented, Ticket 01 remains a complete, independently releasable startup-hardening slice. If this ticket lands with no further candidates, the full Lean V1 specification is delivered; it has no undeclared follow-up dependency.

**Commutativity test:** The only valid merge order is Ticket 01 followed by Ticket 02. Reversing the order cannot preserve the startup contract or real integration and E2E evidence because the required Module and credential seams do not yet exist. This non-commutativity is the reason for the blocking edge.
