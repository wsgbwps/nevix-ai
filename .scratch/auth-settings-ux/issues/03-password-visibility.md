# 03 — 密码独立显示与失焦安全遮蔽

**What to build:** 为登录密码、注册密码、注册确认密码和恢复新密码分别提供明确的显示/隐藏控制，并在离开当前认证步骤、窗口失焦或最小化时立即重新遮蔽，但不清空 User 的输入。

**Blocked by:** None — can start immediately

**Status:** in-review

**Consumes**

- Authentication Feature 现有 login/signup/recovery flow 与字段。
- 真实 renderer window blur、document visibility 和 BrowserWindow minimize 验收 seam。

**Produces**

- 四个密码字段各自独立的显示状态和双语控制。
- 流程转换与窗口安全事件共用的“仅遮蔽、不清值”行为。

**Owns**

- 密码字段本地显示状态、默认值、逐字段切换与安全重置。
- 不改变密码 policy、认证请求或 Session 状态机。

**Acceptance**

- [ ] 登录密码、注册密码、确认密码和恢复新密码都默认隐藏并可分别切换。
- [ ] 显示一个注册字段不会显示另一个字段。
- [ ] 离开当前 authentication flow step 后，该步骤的所有密码显示状态恢复为隐藏。
- [ ] renderer 窗口 blur、document 不可见或 BrowserWindow minimize 时，所有已显示密码立即恢复隐藏且输入值不变。
- [ ] E2E 不记录、截图或 snapshot 原始密码。
- [ ] `Authentication Usability Desktop E2E`、Desktop lint/typecheck/build 与 packaged localization 通过。
- [ ] 产品代码前记录短实施计划；最后代码修改后绑定 final-state evidence 并关闭 finding ledger。

**Parallel classification:** full parallel; `parallel-ready` from the current fixed point.

**Absence test:** 即使 Remembered Email、native editing、Auth policy 和 Settings 主线全部缺席，本票仍可通过真实 BrowserWindow 完整验收。

**Commutativity test:** 与 01/04 任意顺序合并都保持 CI 通过；本票不决定登录存储或密码政策 interface。

## Comments

- 2026-08-13: Implemented on `feat/auth-password-visibility`. Local focused Electron acceptance covers independent login/signup controls, flow reset, BrowserWindow blur/minimize, controlled document visibility loss, and retained non-secret marker values. The recovery-new-password control is asserted in the existing recovery E2E. Desktop lint, typecheck, build, architecture, unit tests, localization resource contract, and packaged localization pass. The complete `Authentication Usability Desktop E2E` remains for the PR's clean CI runner because the local harness correctly refused to reset an existing shared Supabase Docker stack.
