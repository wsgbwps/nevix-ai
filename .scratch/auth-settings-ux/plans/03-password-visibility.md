# 03 — Password Visibility Implementation Plan

- Fixed point: `21b3873098bf9bd7eb5dfab08fe1826f73edfa8b`
- Primary Domain: Authentication Domain
- Acceptance boundary: login, signup, signup confirmation, and recovery-new-password fields each start masked and toggle independently; leaving a flow step clears that step's password fields and remasks them; renderer blur, document visibility change, or BrowserWindow blur/minimize only remasks revealed fields and preserves their current values; controls are complete in Simplified Chinese and English; acceptance tests never use a real credential as the reveal-test value or snapshot password contents.

## Task-owned paths

- `.scratch/auth-settings-ux/plans/03-password-visibility.md`
- `.scratch/auth-settings-ux/issues/03-password-visibility.md`
- `apps/desktop/src/renderer/src/features/authentication/ui/authentication-screen.tsx`
- `apps/desktop/src/renderer/src/features/authentication/i18n/resources.ts`
- `apps/desktop/src/main/window/main-window.ts`
- `apps/desktop/src/shared/ipc/channel-allowlist.ts`
- `apps/desktop/src/shared/ipc/window/types.ts`
- `apps/desktop/tests/auth/password-visibility.spec.ts`
- `apps/desktop/tests/auth/password-recovery.spec.ts`

## Implementation

1. Add Electron Playwright assertions at the rendered-field seam for default masking, independent signup controls, flow-transition clearing and remasking, retained non-secret marker values on window/document deactivation, renderer blur, document visibility change, BrowserWindow blur/minimize, and the recovery-new-password control.
2. Add one Authentication-local password input presentation component. Each mounted field owns one boolean visibility state and exposes a localized explicit toggle. Existing flow unmounting intentionally clears that step's password fields and visibility state; renderer blur, document visibility change, or the typed Window deactivation event only remasks mounted fields without changing Authentication requests, password policy, or Session state.
3. Have the existing Window platform owner publish one neutral typed `window:deactivated` event on BrowserWindow blur or minimize through the generic preload bridge; update the shared event allowlist without adding a platform IPC adapter or Authentication business logic to Main.
4. Add matching Simplified Chinese and English toggle labels to the Authentication-owned localization resource.

## Verification

- Red/green: `pnpm --filter @nevix/desktop test:e2e:smoke`, then the full `pnpm --filter @nevix/desktop test:e2e` named as `Authentication Usability Desktop E2E`.
- Desktop gates: lint, typecheck, build, and packaged localization verification.
- After the last code edit, bind the smallest relevant current-diff check through `final-state-evidence.mjs`, freeze the task-owned diff, and run one Standards/Spec code review ledger to closure.
