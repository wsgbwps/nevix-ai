# Desktop trusted-command adapter deepening

## Delivery boundary

- **Acceptance boundary:** every Desktop Organization trusted write uses the Domain-local trusted-command adapter; Organization creation and Invitation acceptance stop calling `fetch` directly while preserving their user-visible success, validation, cancellation, and failure behavior.
- **Base commit:** `1113ad47cecc3dd291fe7dd733630f0219264ec8`.
- **Risk:** high. This changes the Desktop side of the ADR-0004 trusted-execution seam and requires an independent Electron security review before acceptance.
- **Primary Domain:** Desktop **Organization Domain**.
- **Narrow owner:** `apps/desktop/src/renderer/src/features/organization/api/` owns the command adapter and command-specific response interpretation.
- **Supporting owner:** `apps/desktop/tests/unit/` owns observable interface regressions. No shared source area changes are planned.
- **Explicit exclusions:** no Server identity Module, Supabase/RLS, public HTTP contract, route, UI, localization, dependency, retry, or persistent-data change.

## Confirmed module decisions

The User confirmed every recommendation during the architecture grilling loop:

1. This is behavior-preserving deepening, not a command-contract redesign.
2. The adapter remains inside the Organization Domain; it is not promoted to a renderer shared area.
3. All Organization trusted writes must pass through one adapter seam; no compatibility fallback remains.
4. Callers provide the access token. The adapter never reads the Supabase Session.
5. The existing Domain-local transport interface stays small; no command registry or command-object framework is introduced.
6. The adapter owns public Server configuration, URL construction, authorization/content headers, `fetch`, JSON parsing, the common error envelope, and explicitly requested error-header capture.
7. The adapter never exposes a raw `Response`. It retains only command-declared response headers in normalized failure data.
8. Command modules continue to validate successful domain response shapes and translate command-specific failures. Invitation attempts remain Invitation semantics.
9. `AbortSignal` continues through the adapter. Trusted writes are never retried automatically or replayed across redirects.
10. The existing `command-client.ts` is deepened in place; no new source layer or top-level directory is created.

## Pre-agreed interface seams

Tests are written red-first, one vertical slice at a time, only at these confirmed seams:

1. **Trusted-command adapter interface:** a mocked owned-Server HTTP seam proves authorization/config/JSON transport, normalized common failure, declared-header capture, malformed success handling, `AbortSignal`, no retry, and redirect rejection without write replay.
2. **Create Organization command interface:** creation reaches the canonical adapter and retains id/name response validation plus its existing generic request failure presented to callers.
3. **Accept Organization Invitation command interface:** acceptance reaches the canonical adapter and retains stable error code/message, authoritative attempts remaining, and accepted Organization response validation.
4. **Desktop Organization user seam:** existing onboarding and Invitation-acceptance Playwright scenarios remain green; this task adds no UI behavior.

Tests mock only the real remote dependency at the adapter seam. They do not mock Organization Domain modules or assert private call order.

## Red-green implementation slices

1. Add one failing adapter test for normalized failure and declared-header capture; minimally enrich `OrganizationCommandError` without exposing `Response` or changing existing access-loss classification.
2. Add adapter tests for authorization/JSON transport, malformed success, `AbortSignal`, and one-attempt-only behavior; make only the minimum adapter changes required.
3. Add a failing Create Organization interface test proving canonical transport behavior and response validation; replace its direct `fetch` with `requestOrganizationCommand` and preserve its public failure semantics.
4. Add a failing Invitation acceptance interface test proving code/message/attempt count and response validation; replace its direct `fetch` and local response parser with normalized failure translation.
5. Run the mechanical completion check: no Organization trusted-write module outside `command-client.ts` directly calls `fetch`.

## Verification and review

After the last edit:

- Run targeted adapter/Create/Invitation unit tests.
- Run Desktop typecheck, lint, unit, and architecture checks.
- Run the existing onboarding and Invitation-acceptance E2E scenarios when the local E2E prerequisites are available; otherwise report the exact blocker without claiming that coverage.
- Inspect `git diff --name-status`; every source path must remain in the Organization Domain, with tests as the only supporting area.
- Run an independent Electron security review focused on token handling, error/header exposure, retries, URL construction, and bypasses.
- Run a full patch review and close all blocker findings.
- Bind the final acceptance boundary, `origin/main` base, final diff digest, relevant check coverage, finding ledger, and review conclusion through `docs/specs/final-state-evidence.md`.

## Rollback

The candidate is code-only and reverts as one vertical slice. It introduces no schema, migration, Server contract, stored state, compatibility mode, or staged rollout.
