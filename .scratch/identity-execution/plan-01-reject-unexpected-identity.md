# Plan 01 — Reject unexpected PostgreSQL identity at startup

High-risk security-boundary change (authentication/startup hardening). Scope is
ticket 01 only; the per-transaction runner belongs to ticket 02.

## Acceptance boundary

Identity Module construction succeeds only when its runtime pool authenticates
directly as `identity_app`, proven by a real database round trip observing
`session_user` and `current_user`. Owner/migration/other-role credentials
(including ones that can `SET ROLE identity_app`) and unreachable databases
fail construction before the HTTP listener and Worker start. Go integration and
Desktop E2E run the real Module/Server on an ephemeral `identity_app` runtime
credential; the owner credential remains only for fixtures, catalog
inspection, and authoritative assertions.

## Fixed point

`main` @ 66eadb5 (branch cut: `feat/identity-startup-execution-identity`).

## Primary Domain

Server Identity. Supporting: Server composition root (fallible construction
handling), local/CI integration harness, Desktop E2E harness script, ADR/CONTEXT docs.

## Task-owned paths

- `server/internal/identity/module.go` — context-bearing, fallible `NewModule`
  with the startup identity check (`session_user` + `current_user` == `identity_app`),
  exported `ErrUnexpectedDatabaseIdentity` sentinel.
- `server/internal/identity/execution_identity_test.go` — new unit test for the
  identity decision (four quadrants, sentinel).
- `server/cmd/server/main.go` — pass startup ctx to `NewModule`.
- `server/internal/identity/integrationtest/` — harness split: owner pool
  (`NEVIX_DATABASE_URL`, fixtures/assertions) vs runtime pool
  (`NEVIX_IDENTITY_DATABASE_URL`, all Module construction); new
  `startup_identity_test.go` (accept direct login, reject owner, reject
  assumed role via `SET ROLE`, unreachable DB fails, `identity_app` role
  attributes).
- `scripts/lib/supabase-local-harness.sh` — shared ephemeral
  `identity_app` credential provisioning helper (Go integration + Desktop E2E).
- `scripts/tests/supabase-local-harness.test.sh` — coverage for the helper.
- `scripts/test-mail-smoke.sh` — provision and export the runtime credential.
- `apps/desktop/scripts/run-e2e.sh` — real server runs on the runtime
  credential; owner URL stays for test fixtures; log redaction for the
  runtime URL.
- `docs/adr/0008-identity-write-boundary-and-rls-grant-structure.md` —
  amendment: direct-login runtime invariant.
- `server/CONTEXT.md` — authentication-identity / execution-identity vocabulary.

## Key decisions

- Check lives in `module.go` (composition surface); no new sub-package before
  ticket 02's runner exists. A pure decision function keeps both checks
  independently testable; real-role acceptance/rejection is proven against the
  live stack (ticket acceptance).
- Startup mismatch error carries expected-vs-observed roles for operators
  (internal visibility); it never contains connection strings or credentials.
  Public HTTP behavior is unchanged.
- Runtime credential: fresh random password via `ALTER ROLE identity_app`
  through the stack's db container (same pattern as the `server-mailpit`
  Makefile target), printed as a `postgresql://identity_app:…@127.0.0.1:54322`
  URL; lives only in the harness process env; stack is destroyed with
  `--no-backup`. Provisioned after `db reset` (role outlives the dropped db).
- Existing commands' `SET LOCAL ROLE identity_app` statements stay in this
  ticket (harmless no-op under direct login); their removal belongs to ticket
  02's runner.

## Verification

- `go build ./...`, `go vet`, identity unit tests (no DB needed).
- Full real-stack integration via `./scripts/test-identity-integration.sh`
  (local Docker is unavailable on this host today; the PR's Identity
  Integration CI job runs the same harness script and is the binding
  evidence, watched per delivery.md before merge).
- `bash scripts/tests/supabase-local-harness.test.sh` for the shared lib.
- Desktop E2E smoke via CI on the PR (e2e-relevant paths change).

## Out of scope (ticket 02+)

Per-transaction runner, removal of per-command `SET LOCAL ROLE`, transaction
contract tests, runtime (post-startup) mismatch behavior.
