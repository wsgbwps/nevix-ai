# 06 — Go 邀请命令组 + 审计写入基建 + 携码模板

**What to build:** Invitation 全生命周期的四条 trusted command：CreateInvitation（邀请活跃成员邮箱拒绝、已结束成员邮箱允许）、ResendInvitation（保留同行、重置 7 天、新码 supersede 旧码）、RevokeInvitation、AcceptInvitation（单事务五步：验码 → 建 membership → 邀请置 accepted → 写审计行 → 码置 consumed）。幂等靠 DB 约束 + 状态机 no-op；并发控制为单事务 SELECT … FOR UPDATE + 唯一索引兜底。每次错误验证码消耗 5 次尝试上限之一（failed_attempts 由命令层执行）。本 ticket 首次建立两条共享基建供 ticket 07 复用：审计行写入（actor/target 显示名写入时快照）与 Outbox 单封双语模板渲染（Go embed 模板、写入时渲染、Worker 保持纯投递器、每收件人一行）。携码 invitation 模板经 verification_code_id 关联，重试地平线复用现有机制。传输沿用 Bearer JWT 与防枚举语义：非成员目标 404、角色不足 403 带具体 snake_case 错误码；纯入队返 202。openapi 新增条目并在 PR 描述 call out。

**Blocked by:** 02 — Go 传输基座 + CreateOrganization；05 — Schema：invitations / audit_logs + verification_codes 扩展

**Status:** in-review

- [x] 四命令集成测试覆盖创建/重发/撤销/接受，含活跃成员邮箱拒绝与已结束成员邮箱允许
- [x] 5 次尝试上限与过期/撤销码的明确拒绝经集成测试验证
- [x] 邀请并发接受竞态测试通过（唯一索引兜底，不产生重复活跃 Membership）
- [x] 审计行快照内容与携码邮件（单封双语、重试地平线）逐事件核对
- [x] 防枚举 404/403 语义与错误码经测试断言；openapi 对照校验通过
- [x] server/ 与 contracts/ 属 CI 门禁路径，走 feature branch + PR

## Comments

- 2026-08-10: Implemented on `feat/identity-invitation-commands` in `5fe0a3e`. Verified with `go vet ./...`, the repeated targeted race/validation suite, `scripts/test-mail-smoke.sh`, `go test -race -count=1 ./...`, `pnpm lint`, and a final two-axis review with no findings. Awaiting PR CI and merge.
