# 11 — Settings-origin Organization picker 与跨 Organization 恢复

**What to build:** 让从 Settings 主动进入的 Organization picker 成为一个可取消、保留原 Active Organization 直到新选择成功的导航流程；它必须统一尊重 Profile/Organization Details 草稿、Members command pending/unknown、Audit export-active 和 fresh Membership 结果，并在选择、创建或接受 Invitation 成功后返回原 Settings Section；startup-origin picker 的成功落点仍为 Home。

**Blocked by:** 05 — Focused Account Settings 与普通关闭保护; 07 — Membership-verified Organization Settings; 08 — Organization Details 独立 Section 生命周期; 09 — Members 与 Invitation trusted command 的确定性生命周期; 10 — Audit Log fail-closed 与确定性导出

**Status:** resolved

**Consumes**

- 05 的 Section/source/navigation intent 和完整 contribution lifecycle。
- 07 的 Membership verification 与 confirmed-loss/unknown 语义。
- 08 的 Organization Details dirty/saving/discard lifecycle。
- 09 的 command pending/unknown result lifecycle。
- 10 的 Audit permission fallback 和 export-active lifecycle。
- 现有 startup picker、Organization onboarding、selection、creation、Invitation acceptance 和 Active Organization 设备记忆。

**Produces**

- Organization picker origin interface，区分 `startup` 与 `settings`。
- Settings return target，保存原 Section 和 source descriptor。
- Settings-origin 的 deferred Active Organization commit、cancel 和 success transition。

**Owns**

- 从 Settings 进入 picker 前的统一 navigation guard。
- 保留原 Active Organization 直到新 Organization 选择/创建/邀请接受成功的状态转换。
- picker cancel、原 Membership 失效、Settings-origin success、startup-origin success 和新角色 Section fallback。
- picker 集成所需的 Organization Feature public exports、i18n 与 app composition 机械性收口；不重定义 blockers 已拥有的状态机。

**Acceptance**

- [x] 从 Settings 打开 picker 时，原 Active Organization 继续有效，直到新选择成功才替换。
- [x] 清洁状态下取消 picker 会返回原 Settings Section；如果原 Membership 仍然 active，Organization context 不变。
- [x] 原 Membership 在 picker 打开期间结束时，取消不能恢复无效上下文，而是走现有正常选择或 onboarding resolution。
- [x] Settings-origin 的 Organization selection、Organization creation 和 Invitation acceptance 成功后都返回原 Section，并使用 fresh Membership 应用可见性和 Audit-to-Members fallback。
- [x] startup-origin picker 的上述成功行为仍落到 Home，不生成 Settings return target。
- [x] dirty Profile 或 Organization Details 在打开 picker 前进入丢弃确认；确认丢弃后即使取消 picker，返回时也重读权威值而不恢复草稿。
- [x] Profile 或 Organization Details saving、Members command pending/unknown 或 Audit export-active 时不能进入 picker。
- [x] Organization 切换后重新验证 Settings source；source 在新 Organization 不可进入时 fallback Home。
- [x] 账户组 Section 在 Organization switch 后保持；Organization Section 在仍允许时保持；Audit 失权时改为 Members。
- [x] 新 Organization 下进入 Members 时默认为 Members tab，不恢复上一 Organization 的 Pending Invitations tab。
- [x] `Settings Information Architecture Desktop E2E`、startup picker/onboarding/invitation regression、Desktop lint/typecheck/build 与 packaged localization 通过。
- [x] 产品代码前记录短实施计划；最后代码修改后绑定 final-state evidence 并关闭 finding ledger。

## Implementation Plan

- 在 Organization Feature 中把 picker 选择改为 fresh Membership 成功后才提交 Active Organization；Settings-origin 打开时保留旧上下文，并在取消时重新验证原 Membership，confirmed loss 继续正常 picker/onboarding，unknown 不误判为失权。
- 在 app-owned Settings navigation state 中携带 picker origin、phase 与原 Settings entry；Settings coordinator 继续统一执行 dirty/saving/command/audit guard，并在现有 `/settings` 聚合内收口取消、选择、创建与 Invitation success，避免让保留 Active Organization 的流程进入 pre-shell routes。
- 通过现有 unit seam 覆盖 picker history state 与 pre-shell route boundary，通过 Electron Playwright 覆盖取消、草稿丢弃、选择/创建/Invitation 返回、post-command Membership reconciliation、Audit-to-Members fallback、原 Membership 结束和 startup regression；随后运行 Desktop 静态检查、构建与 packaged localization。

**Parallel classification:** stacked convergence behind 05 and 07–10; it is not `parallel-ready` before every blocker resolves.

**Absence test:** 任一 blocker 缺席都无法完整验收全 Section guard、Audit fallback 或 picker 返回，因此它们都是真实依赖；Authentication 主线全部缺席不影响本票。

**Commutativity test:** 与 05、07–10 不满足交换律，必须在它们全部合并后实现与合并；与 01–04 的合并顺序完全可交换。
