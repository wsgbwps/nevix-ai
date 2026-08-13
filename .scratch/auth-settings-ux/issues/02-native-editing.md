# 02 — 所有可编辑字段恢复原生编辑能力

**What to build:** 让 Desktop 中每个真正可编辑的字段都像标准桌面应用一样支持键盘剪贴板快捷键与右键编辑菜单，包括密码和验证码的粘贴，同时不把该能力扩大成通用浏览器菜单。

**Blocked by:** None — can start immediately

**Status:** in-review

**Consumes**

- 现有 Window platform owner 与 BrowserWindow 安全配置。
- Renderer 内现有的 input、textarea 和其他可编辑 target。
- 真实 Electron 窗口与 editable control E2E seam。

**Produces**

- 只在当前 target 可编辑时提供的标准 undo、cut、copy、paste、delete 和 select-all 原生角色。
- 与平台一致的编辑 accelerators 和右键菜单。

**Owns**

- Window platform 对 editable target 的判定和原生编辑角色组装。
- 该行为不包含 Authentication 或其他 Domain 业务规则。

**Acceptance**

- [ ] 可编辑字段中的标准键盘快捷键会改变字段值，而不只是检查菜单实现。
- [ ] 右键菜单仅为 editable target 显示当前可用的标准编辑角色。
- [ ] 登录、注册、密码恢复的密码字段与所有一次性验证码字段允许粘贴。
- [ ] 不增加后退/前进、重载、新窗口、外部导航或开发者工具入口。
- [ ] `Authentication Usability Desktop E2E`、Electron security regression、Desktop lint/typecheck/build 通过。
- [ ] 最后代码修改后绑定 final-state evidence 并关闭 finding ledger。

**Parallel classification:** full parallel; `parallel-ready` from the current fixed point.

**Absence test:** 不依赖 Remembered Email、密码显示、Auth policy 或 Settings coordinator，可单独验收。

**Commutativity test:** 与 05 的 Window close protocol 可任意顺序合并；02 只拥有编辑菜单语义，05 只拥有关闭意图语义。

## Comments

### Implementation plan — 2026-08-13

- **Acceptance boundary:** real Electron editable targets receive standard undo, cut, copy,
  paste, delete, and select-all behavior through native roles and platform accelerators; non-editable
  targets receive no context menu, and no navigation, reload, window-opening, external-navigation, or
  developer-tools command is introduced.
- **Fixed point:** `21b3873098bf9bd7eb5dfab08fe1826f73edfa8b` (`origin/main`).
- **Primary owner:** Desktop Window platform owner (non-Domain); Authentication supplies only the
  password and one-time-code acceptance controls and gains no business rule or new interface.
- **Task-owned paths:** `.scratch/auth-settings-ux/issues/02-native-editing.md`,
  `apps/desktop/src/main/window/native-editing.ts`,
  `apps/desktop/src/main/window/main-window.ts`, `apps/desktop/src/main/index.ts`, and
  `apps/desktop/tests/window/native-editing.spec.ts`, plus the existing
  `apps/desktop/tests/i18n/startup-language.spec.ts` regression whose old no-menu assertion must
  recognize the managed hidden edit-accelerator menu introduced by this slice.
- **Test seam:** the ticket-approved Electron Playwright seam launches the real BrowserWindow,
  observes native Menu roles for renderer context-menu events, and verifies resulting editable-field
  values after real platform accelerators. Authentication password and one-time-code inputs are
  exercised without inspecting React internals.
- **Delivery:** add the failing E2E first; implement only Window-owned native edit menus and wiring;
  run the focused E2E, Electron security regression, Desktop lint/typecheck/build, then the relevant
  full E2E gate; close the bounded finding ledger and final-state evidence before commit and PR.

### CI repair plan — 2026-08-13

- Manual Full E2E run `31702275056` passed both native-editing scenarios and exposed one stale
  startup-language regression: it still required the application menu to be `null`.
- The approved repair changes only that regression to require exactly the six hidden native editing
  roles. This preserves the prohibition on visible or browser-navigation commands without changing
  product behavior.
