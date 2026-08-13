# 05 — Settings coordinator implementation plan

## Delivery boundary

- **Acceptance boundary:** ticket 05 only: one top-level `/settings` route mounts one
  Settings Section; Profile and Language share source-aware return, dirty/saving
  navigation rules, and ordinary-close protection; Profile rereads authoritative data
  on mount and retains a failed-save draft; Language remains immediate-save. Later
  Organization tickets may consume the coordinator lifecycle interface, but this PR
  does not implement Organization Details, permission verification, command timeout,
  Audit lifecycle, or Settings-origin picker behavior.
- **Fixed point:** `21b3873098bf9bd7eb5dfab08fe1826f73edfa8b`
  (`origin/main` when the branch was created).
- **Primary owner:** Desktop `renderer/src/app/pages/`, which owns the cross-Feature
  Settings Page composition and coordinator. Settings remains neither a Domain nor a
  Feature.
- **Supporting owners:** the Profile Feature owns authoritative Profile reads/writes,
  draft/error state, and its contribution lifecycle; the Language Feature remains an
  immediate-save contribution; the existing Window platform owner transports ordinary
  close intent and decisions without owning dirty/save business rules.

## Architecture decision delivered first

The finalized ticket requires an asynchronous ordinary-close request/decision protocol.
The generic preload already exposes the required typed `on` and `invoke` primitives, but
the current architecture rules reject every platform-owned IPC adapter. The first commit
will therefore record and enforce one narrow exception:

1. `window` may own typed Channels under `shared/ipc/window/types.ts` and a registration
   module plus directly nested Handler under `main/window/ipc/`.
2. The adapter follows the same pure synchronous `register(): void`, direct Handler,
   Channel-prefix, declaration-merging, and generic-preload rules as Domain adapters.
3. `updater` and `tray` remain prohibited from owning IPC. No allowlist debt or second
   registration glob is introduced.
4. Renderer Settings is documented as the authenticated full-screen aggregation-page
   exception already defined by the Desktop ubiquitous language and finalized spec.

The architecture commit owns only this plan, `README.md`, `apps/desktop/AGENTS.md`,
Desktop ADR-0003/ADR-0004, and the architecture verifier plus its contract tests. It
contains no product behavior.

## Product interface and task-owned paths

- `renderer/src/app/pages/settings-page.tsx` and responsibility-named local modules own
  Section/source state, intent coordination, discard confirmation, and close decisions.
- `renderer/src/app/shell/app-shell.tsx` creates the Settings history entry from the
  current memory-history location. Section changes replace that entry; successful return
  uses the adjacent recorded source only when its key and descriptor still match,
  otherwise Settings is replaced with Home.
- `renderer/src/features/profile/ui/profile-settings.tsx` and its public Feature index
  expose only the externally meaningful lifecycle and discard capability. Profile
  validation, Supabase reads/writes, draft state, and retryable save error remain inside
  the Feature.
- `shared/ipc/window/types.ts`, `main/window/`, and the shared Channel allowlist own the
  correlated ordinary-close request/decision protocol. Generic preload files remain
  unchanged.
- App and Feature localization owners provide complete Simplified Chinese and English
  text. Existing shared UI primitives are reused.
- Settings E2E and Window/unit security tests own observable acceptance. No nested route,
  URL/hash Section state, shared navigation framework, Settings Feature, schema, RLS,
  public HTTP contract, or dependency change is allowed.

Every exact changed path will be frozen before the initial code review; unrelated working
tree changes are excluded explicitly.

## Pre-agreed seams and vertical checks

1. **Architecture verifier seam:** a canonical Window adapter passes the same registration,
   nesting, prefix, and shared-declaration rules; Updater/Tray adapters still fail.
2. **Electron Playwright seam:** a real Settings entry defaults to Profile and mounts only
   the selected Section; Section replacement does not add replayable history; Back and
   “Back to app” share source validation; Language remains immediate-save.
3. **Profile UI through Electron:** dirty navigation shows only continue/discard, discard
   sends no write, mount rereads authoritative Profile, and save failure retains the draft
   with a retryable error.
4. **Real BrowserWindow close seam:** dirty close reuses the discard decision; saving close
   waits, then closes on success or remains mounted with the failed draft on error.
5. **Static and localization gates:** Desktop typecheck, lint, unit, architecture,
   component/E2E as applicable, build, resource contract, and packaged localization pass.

Tests are added red-first one behavior slice at a time. After the final product edit, the
smallest relevant current-diff check runs through the final-state-evidence wrapper; one
full Standards/Spec review produces the finding ledger, with only accepted blockers
eligible for the bounded targeted repair loop.

## Commits and rollback

1. `docs(desktop): authorize window ipc seam` — plan, architecture documentation, and
   verifier contract. It is independently testable and reverts without product state.
2. `feat(desktop): coordinate focused settings` — typed Window protocol, Settings/Profile
   behavior, localization, and tests. It adds no persistent data or migration and reverts
   as one product slice after commit 1.

Both commits land in one draft PR as explicitly authorized by the User on 2026-08-13.
