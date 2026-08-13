# 03 — Password Visibility Implementation Plan

- Fixed point: `21b3873098bf9bd7eb5dfab08fe1826f73edfa8b`
- Primary Domain: Authentication Domain
- Acceptance boundary: login, signup, signup confirmation, and recovery-new-password fields each start masked and toggle independently; leaving a flow step, renderer blur, document visibility change, or BrowserWindow minimize remasks revealed fields without changing the current field value; controls are complete in Simplified Chinese and English; acceptance tests never use a real credential as the reveal-test value or snapshot password contents.

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

1. Add Electron Playwright assertions at the rendered-field seam for default masking, independent signup controls, flow-reset masking, retained non-secret marker values, renderer blur, document visibility change, BrowserWindow minimize, and the recovery-new-password control.
2. Add one Authentication-local password input presentation component. Each mounted field owns one boolean visibility state, exposes a localized explicit toggle, and remasks on renderer blur, document visibility change, or the typed Window deactivation event. Existing flow unmounting resets visibility without changing Authentication requests, password policy, or Session state.
3. Have the existing Window platform owner publish one neutral typed `window:deactivated` event on BrowserWindow blur or minimize through the generic preload bridge; update the shared event allowlist without adding a platform IPC adapter or Authentication business logic to Main.
4. Add matching Simplified Chinese and English toggle labels to the Authentication-owned localization resource.

## Verification

- Red/green: `pnpm --filter @nevix/desktop test:e2e:smoke`, then the full `pnpm --filter @nevix/desktop test:e2e` named as `Authentication Usability Desktop E2E`.
- Desktop gates: lint, typecheck, build, and packaged localization verification.
- After the last code edit, bind the smallest relevant current-diff check through `final-state-evidence.mjs`, freeze the task-owned diff, and run one Standards/Spec code review ledger to closure.
