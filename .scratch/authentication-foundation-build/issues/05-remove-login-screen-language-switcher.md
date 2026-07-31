# 05 — Remove the Login-Screen Language Switcher, Follow System by Default

**What to build:** A signed-out user launching Desktop sees the entire unauthenticated boundary — login, signup, verification and recovery states — in the Interface Language resolved from the highest-priority system language (or from a previously saved per-device Language Mode), with no language switch control anywhere on that first screen. Language Mode selection lives only inside the authenticated app shell, where changing it still applies immediately without reload and persists per device across restarts.

**Blocked by:** None — can start immediately (the login boundary, authenticated app shell and startup Interface Language contract are already delivered by tickets 01–03).

**Status:** resolved

## Scope and constraints

- This is a deliberate behavior change: language can no longer be changed offline without an account. A previously saved per-device Language Mode still applies at startup; only the ability to change it moves behind sign-in.
- The default startup contract stays follow-system with the existing Simplified Chinese fallback; do not introduce a new default, a first-run language prompt, or an account-level language preference.
- Keep the change inside the Authentication/Language boundaries already established; no router, no new shared primitives, no unrelated refactoring of the language Feature.
- Do not remove the Language Mode IPC contract, persistence, or the follow-system resolution logic — only the unauthenticated placement of the switch UI and the tests that depend on it.

## Acceptance criteria

- [x] No Interface Language radiogroup or any other language switch control is rendered on the unauthenticated boundary in any of its states (login, signup, verification, recovery, restore-failure).
- [x] With no saved Language Mode, startup on the login screen follows the highest-priority system language, including the existing Simplified Chinese fallback contract.
- [x] A previously saved per-device Language Mode still determines the login-screen language at startup even though it cannot be changed there.
- [x] A corrupt or unknown saved Language Mode still falls back to follow-system on the login screen without crashing.
- [x] The language switcher remains available in the authenticated app shell; changing it updates the visible copy and window title immediately without a page reload, and the choice persists per device across relaunches.
- [x] Playwright i18n coverage is relocated, not deleted: startup follow-system, fallback and corrupt-preference cases stay asserted on the login screen; switch-and-persist cases are proven through the authenticated app shell.
- [x] Simplified Chinese and English resource-contract coverage stays green with no orphaned language-switcher strings on the unauthenticated surfaces.
- [x] Lint, node/web typecheck, build and the affected Electron Playwright scopes pass; the change contains no Profile, Organization, shared Auth package or unrelated refactor.

## Comments

实现完成：

- `renderer/src/app/App.tsx` 不再向 `AuthenticationScreen` 传入语言切换 UI；`features/authentication/ui/authentication-screen.tsx` 删除了随之失效的 `secondaryContent` 属性与渲染插槽，未认证边界的任何状态都不再存在放置该控件的接缝。
- Language Mode 的 IPC 契约、`language-mode.json` 设备持久化与 follow-system（简体中文回退）解析逻辑保持不变，`LanguageModeSettings` 仅在已认证应用 Shell 内渲染。
- `tests/i18n/language-mode-settings.spec.ts` 覆盖已迁移而非删除：未认证边界（登录 → 注册 → 重置密码）断言无 radiogroup/radio；损坏或未知偏好、已保存设备偏好改为以登录文案与窗口标题断言启动语言；切换即时生效（`navigationCount === 0`）与跨重启持久化通过 Supabase harness 在已认证 Shell 中验证。

验证（`apps/desktop`）：`pnpm lint`、`pnpm typecheck`（node + web）、`prettier --check`、`pnpm verify:architecture`、`electron-vite build`，以及完整 `pnpm test:auth`——33 passed / 3 skipped（Linux 专属与配置错误场景）。

遗留说明：verification 与 recovery-verification 两个需要网络的状态由「属性已删除」的结构性保证加上可达状态下的全局 `radio` 计数断言覆盖，未为观察验证码界面而在 i18n 用例中新增发信步骤。
