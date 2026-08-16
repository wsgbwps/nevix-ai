# 09 — Members 与 Invitation trusted command 的确定性生命周期

**What to build:** 让邀请创建/重发/撤销、角色变更、成员移除与退出等 trusted command 在 Settings 中具有可确定的一次提交边界：一旦提交就阻止导航和普通关闭，15 秒内未收到完整响应则一律视为未知结果，不重放写请求，而是通过权威重读判断已成功、可安全重试或仍未确认。

**Blocked by:** 05 — Focused Account Settings 与普通关闭保护; 07 — Membership-verified Organization Settings

**Status:** resolved

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

- [x] 重新进入 Members 或切换 Organization 时默认选中 Members tab，tab 不写入 Settings history。
- [x] fresh role 无邀请管理能力时不展示 Pending Invitations tab。
- [x] 任一成员或 Invitation trusted command pending 期间，Section switch、back、leave、Organization switch、picker entry 和 ordinary close 全部阻止。
- [x] 15 秒从写请求发出计算到完整响应被收到；到期终止客户端等待，但不再发出写请求。
- [x] 每个命令的 terminal response 后都重读 Membership、Members 和 Invitations，而不只刷新一个投影。
- [x] timeout 后立即发起同样的三投影权威重读；已提交、未提交和仍未确认结果都有可控 E2E 覆盖。
- [x] 重读成功时显示实际状态，仅在权威状态证明写操作未发生且仍合法时允许重试。
- [x] 重读失败时保持“结果尚未确认”，禁用同一写操作与所有依赖该状态的 action，只提供“重新检查”。
- [x] 受控网络测试断言 timeout 场景中每个用户操作只发出一次写请求。
- [x] `Settings Information Architecture Desktop E2E`、既有 Members/Invitation E2E regression、Desktop lint/typecheck/build 与 packaged localization 通过。
- [x] 产品代码前记录短实施计划；最后代码修改后绑定 final-state evidence 并关闭 finding ledger。

**Parallel classification:** full parallel with 08 and 10 from the fixed point after 05 and 07; it may start before 06 finishes and becomes `parallel-ready` when its own blockers resolve.

**Absence test:** Organization Details、Audit 和 picker 票全部缺席时，Members/Invitation command 的确定性闭环仍可独立验收。

**Commutativity test:** 与 08/10 任意顺序合并都保持 main 完整且 CI 通过；09 只对 Members 文件中的机械性重叠负责收口。

## Comments

- 2026-08-16: 从 fixed point `3c08e5c3b0036d78c34d656f7f363eeb8b76cb51` 完成 Desktop Organization Domain 的确定性 Members command lifecycle。共享的 15 秒边界对 Invitation、角色变更、成员移除与退出只发送一次可中止请求；terminal response 或 timeout 后统一重读 Membership、Members、Invitations，只有权威状态同时证明未提交且仍合法时才开放重试，Create Invitation 无法排除目标已有 active Membership 时保持 unknown-command-result 并只开放显式“重新检查”。Settings Page 仅组合 contribution 状态。
- 本地验收：初始 review 前独立 disposable Supabase/Go runner 下 `Settings Information Architecture Desktop E2E` 16/16 PASS；accepted-blocker repair 后 4 个受影响场景 4/4 PASS（含 Revoke safe retry、committed Create、reconciliation failure 与 delayed `active_membership_exists`），Desktop focused lint/typecheck PASS。最终完整相关门禁及 17 场景 suite 结果由同一最终 diff 的 final-state evidence 绑定。共享 `nevix-ai` Docker 状态未被停止或重置。
- 本 task branch 上的 `resolved` 为候选状态；只有同一最终 diff 的 final-state evidence 与 closed finding ledger 绑定并提交后才成为本地 accepted candidate，达到 `main` 后才具权威性。
