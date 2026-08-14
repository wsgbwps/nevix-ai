# 06 — Organization Details Owner-only 安全闭环

**What to build:** 在不改变现有 Organization settings command 的 route、request 或 response 形状的前提下，让所有 active Member 可查看 Organization Details，但只有 Owner 获得编辑界面并能通过 Go trusted command 修改组织名称；Admin/Member 不只是隐藏按钮，直接调用也必须被同一授权不变式拒绝。

**Blocked by:** None — can start immediately

**Status:** resolved

**Consumes**

- 现有 Organization name trusted command route、request、200 response 和错误信封。
- Active Membership 的 Owner/Admin/Member 角色投影。
- 现有名称更新与 immutable Audit Log 同事务、不写 Outbox 的语义。
- Identity public OpenAPI contract 与真实数据库 HTTP integration harness。

**Produces**

- 所有 active Member 可见、仅 Owner 可编辑的 Organization Details presentation。
- Owner-only `UpdateOrganizationSettings` 授权不变式。
- 同步更新的 public contract 描述、示例和 response-level conformance evidence。

**Owns**

- Organization name 的 public presentation/edit policy。
- Owner 200、blank-name 400、active Admin/Member 403 `insufficient_organization_role`、ended/non-member 404 non-enumeration 语义。
- Organization update + Audit Log 原子性和 no-email 不变式；不改 route、version、response envelope、schema、RLS 或 GRANT。

**Acceptance**

- [x] Owner 在 Desktop 中可编辑并成功更新 trimmed nonblank Organization name，响应与现有 contract 一致。
- [x] 名称更新与 `organization_settings_updated` Audit Log 行同事务提交，不产生 Outbox 行。
- [x] active Admin 与 Member 在 Desktop 中只读；使用它们的身份直接调用 trusted command 都返回现有 `insufficient_organization_role` 403。
- [x] ended Membership、outsider 和 non-member 直接调用保持非枚举 not-found 语义。
- [x] 缺少 `name` 或 trim 后为空仍返回现有 validation 错误。
- [x] public identity contract 只更新授权描述和示例；route、request、200 response 与错误信封不变。
- [x] `Identity Organization Settings Authorization Integration`、OpenAPI response conformance、Owner/Admin/Member Desktop E2E、Desktop/Server 相关构建与检查通过。
- [x] 产品代码前的短实施计划显式绑定 Desktop affordance、Go trusted command 和 public contract 为同一 PR 回滚边界。
- [x] 最后代码修改后绑定 final-state evidence 并关闭 finding ledger。

**Parallel classification:** full parallel; `parallel-ready` from the current fixed point.

**Absence test:** 即使 Settings coordinator 和独立 Organization Details Section 永不实现，当前 Settings presentation 仍能观察 Owner-only UI 并通过直接 HTTP 调用完整验收安全闭环。

**Commutativity test:** 与 01–05 任意顺序合并都保持 main 完整且 CI 通过；本票不决定 Settings coordinator 状态机。

## Comments

- 2026-08-14: [PR #52](https://github.com/wsgbwps/nevix-ai/pull/52) 已 squash merge 为 `11bbfc9`。最终 head 的 [CI gate 31703561245](https://github.com/wsgbwps/nevix-ai/actions/runs/31703561245) 成功；隔离 Supabase 上的 44 条 Identity integration、26 条 Desktop smoke、OpenAPI conformance、Server/Desktop checks 与 audit/no-Outbox 原子性均通过，最终 Standards/Spec review 无 finding。
