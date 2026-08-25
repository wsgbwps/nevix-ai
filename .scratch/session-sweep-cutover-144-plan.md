# Plan: Session sweep、旧实现删除与原子 cutover 验收（#144）

Parent spec: #138. Integration branch: `identity-session-cutover` (already carries
the squashed slices of #139–#143). This ticket is the integration gate: it must
land before the branch's single PR to main.

## Acceptance boundary (what "done" means)

Every acceptance-criteria checkbox of #144 carries verifiable evidence: the last
production Session SQL outside `session/` (the sweep `DELETE`) moves behind the
Session implementation; the dedicated real-database Identity integration run is
green with zero skips and the new sweep sentinels pass; normal unit tests, `go
vet`, and the diff-scope check pass; no schema, HTTP/OpenAPI, or ADR seam
changes; all of tickets #139–#144 ship through exactly one PR.

## Fixed point

`origin/identity-session-cutover` @ `52fe2c5` (branch head; clean tree).

## Primary Domain and task-owned paths

- Domain: Server Identity (spec #138).
- Owner: `server/internal/identity/session/` — the Session responsibility
  module gains the expired-session sweep, completing its seven owned
  responsibilities.
- Adjacent seam (minimal): `server/internal/identity/auth/sessions.go` +
  `auth/sweep.go` — the worker keeps cadence/lifecycle and its other
  maintenance duties (audit retention, login-limiter pruning, initial-password
  reminder) but stops owning the session `DELETE`.
- Shared area touched: none in this slice. The authorization shared seam
  (`server/internal/authz`) changed in the earlier tickets of this branch only.
- Test support: `server/internal/identity/session/session_integration_test.go`
  (package-local real-PostgreSQL tests), `scripts/test-identity-integration.sh`
  (delivery-harness sentinel list — repo-tooling file).

## Changes

1. `session.Service.SweepExpired(ctx) error`: deletes expired sessions through
   the Write Transaction Module runner — same shape as the best-effort
   `refresh` maintenance write; Session still never touches begin/commit
   outside `writetx.Runner`. Failure is reported to the caller (the worker
   logs and retries next tick); logical expiry is enforced by `Validate`
   (`expires_at > now()`) regardless of sweep outcome, so a cleanup outage
   can never extend validity. No audit row, no post-commit effects (spec #138
   reserves those for revocation).
2. `auth.sweepOnce`: drop the inline
   `DELETE FROM public.sessions WHERE expires_at < now()`; call
   `s.sessions.SweepExpired`. Audit retention stays in the worker's own write
   transaction; reminder + limiter pruning unchanged. Session cleanup and
   audit retention become two independent maintenance transactions — partial
   failure simply retries on the next tick.
3. Package-local sweep tests against real PostgreSQL (opt-in contract
   unchanged):
   - expiry precedes deletion: an expired session is rejected by `Validate`
     before any sweep runs; sweep then deletes only expired rows, live
     sessions survive, zero audit rows appear;
   - sweep failure is reported and does not extend validity: `REVOKE DELETE ON
     public.sessions FROM identity_app` (owner) forces a deterministic
     infrastructure failure; the expired session stays rejected by
     `Validate`; after `GRANT` is restored the sweep succeeds. Read paths stay
     privileged so `Validate` keeps answering while cleanup is denied.
4. Sentinels for the new tests in `scripts/test-identity-integration.sh`.

## What this slice deliberately does not do

- No schema migration, no HTTP/OpenAPI change, no new ADR (spec #138 confirms
  the trusted data plane / single-tenant / opaque session / write transaction
  decisions are strengthened, not changed).
- No speculative SSE hub: sweep registers no connection effects; revocation's
  post-commit effect ordering is already covered.
- Audit retention, login limiter pruning, and the initial-password reminder
  stay worker-owned; only expired-session cleanup moves.
- No dual implementation or fallback SQL is introduced or kept: after this
  slice, grepping production code for `public.sessions` outside `session/`
  returns nothing.

## High-risk change notes (authentication/security boundary)

- The moved SQL is byte-for-byte the same predicate the worker ran inline
  (`expires_at < now()`), executed under the same execution-identity-checked
  write transactions; only its owner changes.
- Failure modes are tightened, not loosened: sweep failure was previously
  swallowed together with audit retention inside one logged transaction; now
  it is reported by `SweepExpired` and logged by the worker separately, and
  validity was never sweep-dependent either way (validation enforces expiry).
- Tests prove fail-closed behavior (expired token rejected) before, during,
  and after a forced cleanup outage.

## Shared-area impact for delivery notes

- `server/internal/authz` (authorization shared seam): changed by earlier
  tickets on this branch — `Principal` now carries a non-sensitive `SessionID`
  instead of a bearer-derived token hash; guard and command callers verified
  by `authz` unit tests plus the full Identity contract suite. No further
  change in this slice.
- `scripts/test-identity-integration.sh` is a delivery-harness file riding the
  same PR (not direct-main): sentinel list extension only.

## Verification plan

1. `go build ./... && go vet ./...` in `server/`.
2. `go test ./internal/identity/... ./internal/migration/...` (no env → skips
   integration, runs unit).
3. `./scripts/test-identity-integration.sh` — full dedicated run: zero skips,
   new sentinels pass.
4. Diff-scope check: `git diff --name-status` stays within the declared
   Identity slice + sentinel script.
5. QA walk of every #144 checkbox with evidence; update the issue body.

## Review route

`/code-review` initial pass against the fixed point with this task-owned
pathspec; finding ledger under `.scratch/session-sweep-cutover-144-review-ledger.json`;
bounded repair + targeted re-review per the finding lifecycle; then the single
squash-merge PR for the whole branch (#139–#144), watched per
`docs/agents/delivery.md`.
