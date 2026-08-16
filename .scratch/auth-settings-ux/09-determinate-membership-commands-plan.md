# 09 — Determinate Membership command implementation plan

## Delivery boundary

- **Acceptance boundary:** ticket 09 only. Each Members, Organization Invitation, or leave trusted command has one client submission. From request dispatch until a complete response or the shared 15-second deadline, the Members contribution reports command pending and Settings blocks Section changes, back/leave, Organization switching, picker entry, and ordinary close. Every terminal response and timeout triggers one authoritative reconciliation of Membership, Members, and Invitations. A timeout never replays the write. If timeout reconciliation fails, the contribution remains unknown-command-result, dependent actions stay disabled, and only an explicit “Check again” can reconcile. A successful reread renders actual state and permits the same command again only when that state proves it did not happen and remains legal.
- **Fixed point:** `3c08e5c3b0036d78c34d656f7f363eeb8b76cb51` (`origin/main` when this branch was created).
- **Primary Domain:** Desktop Organization Domain.
- **Supporting boundary:** `renderer/src/app/pages/settings-page.tsx` only composes the Members lifecycle contribution into the existing Settings coordinator. No command or Membership business rule moves into `app/`.
- **Out of scope:** Organization Details, Audit Log, Settings-origin picker behavior, Server command semantics, public contracts, schema/RLS/GRANTs, Realtime, polling, automatic retries, and new shared abstractions.

## Task-owned paths

Planned product and acceptance paths are limited to:

- Existing Organization command transport and Membership/Invitation API files under `apps/desktop/src/renderer/src/features/organization/api/` for abortable single requests.
- Existing Active Organization and Members workflow/UI/i18n/public-interface files under `apps/desktop/src/renderer/src/features/organization/` for the three-projection reconciliation, safe retry decision, temporary Members tab state, lifecycle reporting, and Localized Surface.
- `apps/desktop/src/renderer/src/app/pages/settings-page.tsx` for contribution composition only.
- `apps/desktop/tests/organization/members-management.spec.ts` for the pre-agreed Electron Playwright acceptance seam.
- This plan and `.scratch/auth-settings-ux/issues/09-determinate-membership-commands.md` for local delivery state and acceptance evidence.

Every exact changed path will be tracked and frozen before the single initial review. Any need for a new shared layer, route, persistence mechanism, Server/API contract, or database change is an architecture conflict and stops this slice.

## Pre-agreed seams and vertical checks

The finalized spec already fixes the acceptance seam, so implementation proceeds test-first without a new frontend unit-test framework:

1. **Pending boundary:** hold a real trusted-command response and assert the write request count is one while Settings Section controls, back, Organization switch, picker entry, and ordinary close are blocked.
2. **Timeout reconciliation:** drive the renderer clock to the exact 15-second deadline and control the authoritative reads to cover a committed command, an uncommitted command that is safe to retry, and a reread failure that exposes only “Check again.”
3. **Projection completeness:** observe Membership, Members, and Invitations rereads after both complete terminal responses and timeouts.
4. **Members lifecycle regression:** re-entry and Organization remount start on Members; fresh roles without invitation-management permission expose no Pending Invitations tab; existing invitation, role, removal, and leave paths continue through the shared command lifecycle.
5. **Static/localization gates:** focused Members/Invitation and Settings E2E, Desktop lint/typecheck/build, resource completeness, and packaged localization pass; the relevant full suite runs once before initial review.

Each red → green slice adds only the behavior required by the next observable assertion. After the last product edit, the ticket moves to `in-verification`; final-state evidence, the one full review ledger, and the bounded accepted-blocker repair loop all bind to the same fixed point and exact task-owned diff.

## Rollback

The abortable request signal, Members command state/reconciliation, Settings contribution wiring, localized messages, and E2E assertions revert together as one Desktop Organization slice. Reverting restores the previous best-effort per-projection refresh without persistent data rollback or Server changes.
