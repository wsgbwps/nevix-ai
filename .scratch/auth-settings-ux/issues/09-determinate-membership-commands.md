# 09 — Members 与 Invitation trusted command 的确定性生命周期

**What to build:** 让邀请创建/重发/撤销、角色变更、成员移除与退出等 trusted command 在 Settings 中具有可确定的一次提交边界：一旦提交就阻止导航和普通关闭，15 秒内未收到完整响应则一律视为未知结果，不重放写请求，而是通过权威重读判断已成功、可安全重试或仍未确认。

**Blocked by:** 05 — Focused Account Settings 与普通关闭保护; 07 — Membership-verified Organization Settings

**Status:** ready-for-agent

**Consumes**

- 05 的 command pending/unknown lifecycle 与 navigation/ordinary-close coordinator。
- 07 的 Membership verification 与 fresh role。
- 现有 Members/Invitation trusted commands、RLS-direct Members/Invitations reads 与 Members internal tabs。
- 所有成员与 Invitation command 共用的 15 秒完整响应超时决定。

**Produces**

- Members contribution 的 clean、command pending 和 unknown command result lifecycle report。
- timeout 后的单一 authoritative reconciliation，同时重读 Membership、Members 和 Invitations。
- 未知结果下的“重新检查”行为与安全重试资格。

**Owns**

- 从写请求发出到收到完整响应的 15 秒 timeout 计时与客户端等待终止。
- timeout 结果永远是 unknown，不根据客户端错误猜测未提交，不自动重试写操作。
- Members/Pending Invitations 临时 tab state、fresh-role invitation visibility 和命令后权威投影。

**Acceptance**

- [ ] 重新进入 Members 或切换 Organization 时默认选中 Members tab，tab 不写入 Settings history。
- [ ] fresh role 无邀请管理能力时不展示 Pending Invitations tab。
- [ ] 任一成员或 Invitation trusted command pending 期间，Section switch、back、leave、Organization switch、picker entry 和 ordinary close 全部阻止。
- [ ] 15 秒从写请求发出计算到完整响应被收到；到期终止客户端等待，但不再发出写请求。
- [ ] 每个命令的 terminal response 后都重读 Membership、Members 和 Invitations，而不只刷新一个投影。
- [ ] timeout 后立即发起同样的三投影权威重读；已提交、未提交和仍未确认结果都有可控 E2E 覆盖。
- [ ] 重读成功时显示实际状态，仅在权威状态证明写操作未发生且仍合法时允许重试。
- [ ] 重读失败时保持“结果尚未确认”，禁用同一写操作与所有依赖该状态的 action，只提供“重新检查”。
- [ ] 受控网络测试断言 timeout 场景中每个用户操作只发出一次写请求。
- [ ] `Settings Information Architecture Desktop E2E`、既有 Members/Invitation E2E regression、Desktop lint/typecheck/build 与 packaged localization 通过。
- [ ] 产品代码前记录短实施计划；最后代码修改后绑定 final-state evidence 并关闭 finding ledger。

**Parallel classification:** full parallel with 08 and 10 from the fixed point after 05 and 07; it may start before 06 finishes and becomes `parallel-ready` when its own blockers resolve.

**Absence test:** Organization Details、Audit 和 picker 票全部缺席时，Members/Invitation command 的确定性闭环仍可独立验收。

**Commutativity test:** 与 08/10 任意顺序合并都保持 main 完整且 CI 通过；09 只对 Members 文件中的机械性重叠负责收口。
