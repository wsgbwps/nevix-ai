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

**Status:** ready-for-agent

- [ ] Module construction succeeds when the database connection authenticates directly as `identity_app`.
- [ ] An owner or other role is rejected even when it is permitted to assume `identity_app`.
- [ ] `session_user` and `current_user` are independently verified.
- [ ] An unreachable database fails Module construction before HTTP listener and Worker startup.
- [ ] The owner credential is used only for fixtures, catalog inspection, and authoritative assertions.
- [ ] The real Module in Go integration uses the runtime credential.
- [ ] The real Server in Desktop E2E uses the runtime credential.
- [ ] Existing Identity integration and Full E2E behavior remains green.
- [ ] `identity_app` remains non-superuser, has no `BYPASSRLS` or administrative role attributes, and retains only the intended grants.
- [ ] Temporary credentials are not persisted or exposed in logs.
- [ ] Architecture documentation describes only the direct-login and startup guarantees delivered by this ticket.
- [ ] The relevant checks, independent security review, and final-state evidence pass for this candidate.

**Absence test:** If Ticket 02 is never implemented, this ticket still delivers complete startup hardening: an unexpected database identity cannot start the Server, and all existing Identity paths execute through a directly authenticated least-privilege runtime pool. Main remains buildable, testable, mergeable, and independently reversible.

**Commutativity test:** There is no same-wave candidate, so same-wave commutativity is not applicable. The order with Ticket 02 is intentionally non-commutative: Ticket 02 cannot precede this ticket because it consumes this ticket's Module contract and runtime credential seam.
