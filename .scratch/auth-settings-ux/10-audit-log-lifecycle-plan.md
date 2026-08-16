# 10 — Audit Log lifecycle implementation plan

## Delivery boundary

- **Acceptance boundary:** ticket 10 only: entering Audit Log verifies the current active Membership before any sensitive row read; only a fresh Owner/Admin result can load rows. Membership unknown withholds rows without permission fallback, confirmed Audit permission loss hides the entry and replaces Audit Log with Members, and a verified Membership followed by an Audit data failure stays in Audit Log with a distinct retryable error. Native save-dialog and file-write work report one `audit-export-active` lifecycle that blocks Settings navigation, Organization switching, picker entry, and ordinary close; cancellation immediately returns to clean state and creates no file. Existing all-page keyset export, CSV formula-injection guard, and actual exported count remain unchanged.
- **Fixed point:** `3c08e5c3b0036d78c34d656f7f363eeb8b76cb51` (`origin/main` when this branch was created).
- **Primary Domain:** Desktop Organization Domain.
- **Narrowest owners:** `apps/desktop/src/renderer/src/features/organization/` owns Audit permission/data/export state and its Localized Surface; `apps/desktop/src/main/organization/ipc/` owns the native export boundary and its Audit-only E2E control. `apps/desktop/src/renderer/src/app/pages/settings-page.tsx` remains composition-only while wiring the contribution and permission-loss Section intent. Electron Playwright owns observable acceptance.

## Task-owned paths

Planned product and acceptance paths are limited to:

- `apps/desktop/src/renderer/src/features/organization/model/audit-log-access.ts`
- `apps/desktop/src/renderer/src/features/organization/ui/audit-log-settings.tsx`
- `apps/desktop/src/renderer/src/features/organization/i18n/resources.ts`
- `apps/desktop/src/renderer/src/features/organization/index.ts`
- `apps/desktop/src/renderer/src/app/pages/settings-page.tsx`
- `apps/desktop/src/main/organization/ipc/export-audit-log.ts`
- `apps/desktop/src/main/organization/ipc/audit-log-export-path.ts`
- `apps/desktop/tests/organization/audit-log.spec.ts`
- `apps/desktop/tests/unit/audit-log-export-guard.test.mts`
- This plan and `.scratch/auth-settings-ux/issues/10-audit-log-lifecycle.md` for local delivery state and acceptance evidence.

Every exact changed path will be tracked and frozen before the one initial code review. No Server, public contract, schema, migration, RLS/GRANT policy, shared renderer layer, dependency, nested route, Realtime, polling, or generalized dialog-test framework change is allowed.

## Pre-agreed seams and vertical checks

The finalized spec already fixes the test seams, so implementation proceeds test-first without adding a frontend unit-test framework:

1. **Membership-before-read seam:** Electron Playwright controls the RLS-direct Membership response and observes that unknown starts zero Audit row requests, withholds prior/sensitive content, keeps Audit Log selected, and permits retry.
2. **Audit data seam:** after a verified Owner/Admin Membership, a controlled Audit row failure keeps the Audit Log Section mounted, clears rows, and renders a distinct retryable data error; retry renders authoritative rows.
3. **Confirmed permission-loss seam:** an authoritative fresh Member role hides Audit navigation and replaces the active Audit Log Section with Members.
4. **Native export lifecycle seam:** an Audit-only, unpackaged-E2E save-dialog cancellation control holds the IPC request long enough to observe disabled Settings/back/Organization controls and cancelled ordinary close, then returns `{ saved: false }`; the UI returns to clean state and the test directory remains empty. Existing success E2E continues to prove stable all-page export, formula guard, and actual count.
5. **Static/localization gates:** focused Audit/Settings E2E, Desktop unit/lint/typecheck/build, resource completeness, and packaged localization pass; the relevant full suite runs once before initial review.

Each slice follows red → green with minimum code. After the last product edit, the ticket moves to `in-verification`; the current diff is checked through final-state evidence, reviewed once into the shared finding ledger, and only accepted blockers enter the bounded targeted repair loop.

## Rollback

The Audit verification/data states, Settings contribution wiring, localized messages, native export cancel seam, and E2E assertions form one independently reversible Desktop Organization slice. Reverting it restores the prior Audit surface and success-only E2E export path without persistent data rollback or any Server/database change.
