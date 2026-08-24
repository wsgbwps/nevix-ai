# Authentication internal seams — plan (issue #133, spec #132 prefactor)

High-risk area (Authentication). Brief plan per repository policy, written before implementation.

## Scope

Converge the Authentication implementation's direct dependencies on Go Server
(HTTP), Session persistence (IPC), and Remembered Email persistence (IPC) into
three Domain-semantic internal seams (ports) with substitutable adapters.
Behavior-preserving prefactor: no public interface change, no user-observable
change, no Go Server / OpenAPI / schema / delivery change.

## Primary Domain and owning boundaries

- Primary Domain: **Desktop Authentication**.
- Narrowest owning boundary for every new or moved source file:
  `apps/desktop/src/renderer/src/features/authentication/` — ports, production
  adapters, in-memory adapters, and the rewired hook stay inside the existing
  `api/`, `session/`, and `model/` segments. No new segment, no new owner.
- Directly affected tests: `apps/desktop/tests/unit/` (adapter/unit tests) and
  the existing component/E2E suites (must stay green, no rewrites of E2E).

## Task-owned paths

New (all inside the Feature, none exported through `index.ts`):

- `api/go-authentication.ts` — Go Authentication port (semantic operations +
  result taxonomy + `UserAccount`/`SessionCredentials` domain types).
- `api/go-authentication-http.ts` — production adapter over the existing HTTP
  transport (`api/client.ts` unchanged in behavior; transport contract tests
  stay untouched).
- `api/in-memory-go-authentication.ts` — scriptable in-memory adapter.
- `session/session-persistence.ts` — Session persistence port.
- `session/in-memory-session-persistence.ts` — scriptable in-memory adapter.
- `api/remembered-email-persistence.ts` — Remembered Email persistence port.
- `api/in-memory-remembered-email.ts` — scriptable in-memory adapter.

Reworked in place:

- `session/persisted-session.ts` — becomes the production IPC adapter
  implementing the Session persistence port (same serialization/parsing;
  module-level unavailable flag replaced by port outcomes).
- `api/remembered-email.ts` — becomes the production IPC adapter implementing
  the Remembered Email persistence port (same channels; throws mapped to
  domain outcomes).
- `api/client.ts` — minimal: `UserAccount`/`SessionCredentials` move to the
  port file; HTTP behavior untouched.
- `model/use-authentication.ts` — consumes the three ports; public hook shape
  and behavior identical; production adapters composed inside the Feature.

Tests:

- `tests/unit/go-authentication-http-adapter.test.mts` (new) — semantic
  verdict mapping over a scripted fetch.
- `tests/unit/authentication-in-memory-seams.test.mts` (new) — scriptability:
  queued semantic outcomes, deferred completion, reversed completion order,
  call recording.
- `tests/unit/persisted-session.test.mts` (updated) — drive the same
  canonical-JSON/unreadable/unavailable behavior through the port factory.
- `tests/unit/remembered-email-adapter.test.mts` (new) — IPC outcome mapping
  including throw degradation.

## Non-goals / guards

- No change to the Feature public interface (`index.ts`), broad hook state,
  route props relay, screens, App Shell, Settings Flow, Home.
- No timer port, generic storage, generic cancellation, event bus, consumer
  registry, shared Session owner, or speculative seam.
- Ports/adapters stay internal; app composition is untouched.

## Verification commands (exact)

From `apps/desktop/`:

1. `npm run typecheck`
2. `npm run lint`
3. `npm run test:unit`
4. `npm run test:component`
5. `npm run verify:architecture`
6. `bash scripts/run-e2e.sh` (full suite — Authentication/session-sensitive
   refactor; run before PR, CI gate decides the PR run)
