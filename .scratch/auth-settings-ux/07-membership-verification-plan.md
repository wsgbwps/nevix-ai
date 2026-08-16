# 07 — Membership verification implementation plan

## Delivery boundary

- **Acceptance boundary:** ticket 07 only: entering Members first verifies the current active Membership; the Organization Feature classifies the authoritative RLS-direct read as verified active Membership, confirmed Membership loss, or unknown network/service failure. A verified result refreshes Settings chrome and role-dependent controls. Unknown never triggers fallback or access-lost behavior, preserves any already loaded ordinary roster, and disables writes that require a fresh role. Confirmed loss immediately clears the Active Organization and uses the existing blocking access-lost flow. Tickets 08–11 remain out of scope.
- **Fixed point:** `248314000c93c5746bee98f8c9429aba54bf66e6` (`origin/main` when the branch was created).
- **Primary Domain:** Desktop Organization Domain.
- **Narrowest owner:** `apps/desktop/src/renderer/src/features/organization/` owns the verification result, request generation, authoritative role projection, Members loading policy, and Localized Surface. `renderer/src/app/pages/settings-page.tsx` remains composition-only if it must pass the active Settings Section. Desktop Playwright owns observable acceptance.

## Task-owned paths

Planned product and acceptance paths are limited to:

- Organization Feature Membership verification state/provider and existing Membership API/model/UI consumers under `apps/desktop/src/renderer/src/features/organization/`.
- `apps/desktop/tests/settings/settings-page.spec.ts` for the named Settings acceptance seam and `apps/desktop/tests/organization/session-access-lost.spec.ts` only if the existing confirmed-loss regression needs a direct assertion update.
- This plan and `.scratch/auth-settings-ux/issues/07-membership-verification.md` for local delivery state and acceptance evidence.

Every exact changed path will be frozen before the one initial code review. No Server, public contract, schema, migration, RLS policy, shared renderer layer, dependency, nested route, polling, Realtime, or Settings Domain change is allowed.

## Pre-agreed seams and vertical checks

The finalized spec already fixes the test seams, so implementation will proceed test-first without introducing a new frontend unit-test framework:

1. **Electron Playwright Settings seam:** a fresh role read occurs before Members data/actions; Settings chrome and controls reflect a verified role change.
2. **Membership failure seam:** a failed active-Membership request renders a retryable unknown state, keeps Settings and Active Organization context, and exposes no fresh-role write action. If ordinary roster content is already present, rendering logic keeps it visible.
3. **Confirmed-loss seam:** an authoritative successful read with no current Membership bypasses Settings navigation/dirty decisions, clears Organization context, and opens the existing blocking access-lost flow.
4. **Static/localization gates:** focused Settings E2E and access-lost regression, Desktop lint/typecheck/build, resource completeness, and packaged localization pass; the relevant full suite runs once before initial review.

Each slice follows red → green with the minimum code needed. After the last product edit, the ticket moves to `in-verification`; the current diff is checked through final-state evidence, reviewed once into the shared finding ledger, and only accepted blockers enter the bounded targeted repair loop.

## Rollback

The verification result/state, Members consumption, localization, and E2E assertions form one independently reversible Desktop Organization slice. Reverting it restores the previous best-effort Settings chrome refresh and Members loading behavior without persistent data rollback.
