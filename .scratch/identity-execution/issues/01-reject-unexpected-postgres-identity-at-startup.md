# 01 — Reject unexpected PostgreSQL identity at startup

**What to build:** Make Identity Module startup succeed only when its runtime database connection authenticates directly as `identity_app`. Owner, migration, other-role, and unreachable database connections must fail before HTTP or Worker startup. Go integration and Desktop E2E must use a real runtime credential that is separate from the owner credential used for fixtures and assertions.

**Consumes:**

- The existing `identity_app` LOGIN role, RLS policies, and grants.
- The existing local random-credential provisioning pattern.
- The current `NewModule`, `Register`, and `RunWorkers` Module contract.
- The existing Go integration and Desktop E2E harnesses.
- The existing trusted-command public error seam.

**Produces:**

- A context-bearing, fallible final Module construction contract.
- A directly authenticated `identity_app` runtime credential seam.
- A separate owner fixture and assertion credential seam.
- One credential-provisioning rule shared by Go integration and Desktop E2E.
- Real PostgreSQL evidence for the runtime role attributes and intended grants.
- Architecture and Server vocabulary for the direct-login and startup identity invariant.

**Owns:**

- The startup state transition from unreachable or unexpected database identity to failed Module construction.
- The startup state transition from verified `identity_app` authentication and execution identities to a usable Module.
- The Module construction public interface and composition-root startup error handling.
- Integration and E2E credential generation, propagation, cleanup, and log redaction.
- Startup checks of `session_user` and `current_user`.
- It does not own the per-transaction runner introduced by Ticket 02.

**Blocked by:** None — can start immediately.

**Parallel classification:** Single frontier ticket. It has no full-parallel implementation peer.

**Status:** resolved

- [x] Module construction succeeds when the database connection authenticates directly as `identity_app`.
- [x] An owner or other role is rejected even when it is permitted to assume `identity_app`.
- [x] `session_user` and `current_user` are independently verified.
- [x] An unreachable database fails Module construction before HTTP listener and Worker startup.
- [x] The owner credential is used only for fixtures, catalog inspection, and authoritative assertions.
- [x] The real Module in Go integration uses the runtime credential.
- [x] The real Server in Desktop E2E uses the runtime credential.
- [x] Existing Identity integration and Full E2E behavior remains green.
- [x] `identity_app` remains non-superuser, has no `BYPASSRLS` or administrative role attributes, and retains only the intended grants.
- [x] Temporary credentials are not persisted or exposed in logs.
- [x] Architecture documentation describes only the direct-login and startup guarantees delivered by this ticket.
- [x] The relevant checks, independent security review, and final-state evidence pass for this candidate.

**Absence test:** If Ticket 02 is never implemented, this ticket still delivers complete startup hardening: an unexpected database identity cannot start the Server, and all existing Identity paths execute through a directly authenticated least-privilege runtime pool. Main remains buildable, testable, mergeable, and independently reversible.

**Commutativity test:** There is no same-wave candidate, so same-wave commutativity is not applicable. The order with Ticket 02 is intentionally non-commutative: Ticket 02 cannot precede this ticket because it consumes this ticket's Module contract and runtime credential seam.

## Comments

### Acceptance conclusion (2026-08-18)

Delivered on `feat/identity-startup-execution-identity` against `main` @ 66eadb5; ledger `.scratch/identity-execution/code-review-ledger-01.json` (closed, 1 full review + 1 targeted round, 1 accepted blocker repaired and closed, 3 advisories dispositioned; independent Go security review PASS).

- `identity.NewModule(ctx, pool, cfg)` performs a real round trip requiring `session_user` = `current_user` = `identity_app` (sentinel `ErrUnexpectedDatabaseIdentity`); unreachable DB fails construction as a plain infrastructure error, and the composition root starts the HTTP listener and Worker only after construction succeeds.
- Real-role evidence in `integrationtest/startup_identity_test.go`: direct `identity_app` login accepted; owner rejected although `pg_has_role(...,'MEMBER')`; owner + `AfterConnect SET ROLE identity_app` rejected (authentication identity cannot be replaced by a role switch); unreachable DB rejected; `pg_roles` catalog asserts non-superuser / no BYPASSRLS / no admin attributes / LOGIN. The four-quadrant role decision is unit-tested in `execution_identity_test.go`.
- One credential-provisioning rule — `nevix_supabase_harness_identity_app_database_url` in `scripts/lib/supabase-local-harness.sh` — feeds both harnesses: `NEVIX_IDENTITY_DATABASE_URL` for the Go runtime pool (Module construction only) and the Desktop E2E server `DATABASE_URL`; the owner credential stays fixture/assertion-only in both.
- Local Docker was unavailable, so the real-stack legs ran as the PR's Identity Integration CI and Desktop E2E CI on the identical tree (watched before merge per delivery.md): unit + harness self-tests passed locally (`go build/vet/test`, `make harness-test` 21/21).
- ADR-0008 amendment and `server/CONTEXT.md` vocabulary record only the direct-login and startup guarantees; ticket 02's per-transaction runner remains untouched, and per-command `SET LOCAL ROLE` statements are intentionally retained.
