# 05 — Schema：invitations / audit_logs + verification_codes 扩展

**What to build:** Membership 主切片的数据基座（expand-only）。invitations 表进 public schema：status（pending/accepted/revoked），过期派生自 expires_at 不存 expired 态；UNIQUE(organization_id, email) WHERE status='pending'；RLS 策略使 Owner/Admin 可见本组织行、被邀请人可见 email 等于 jwt email 的 pending 行。audit_logs 表：actor/target 的 user_id 与显示名写入时快照、刻意不加 FK，metadata jsonb，action 为 text 由 Go 单一写入方校验（无 DB CHECK）；不可变性靠 GRANT（client 无写权限、identity_app 无 UPDATE，有 DELETE 供 retention sweep）；RLS 仅 Owner/Admin 只读。identity schema 的 verification_codes expand-only 扩展：+action_type、+target_id、status CHECK 增加 'consumed'、+failed_attempts 列。memberships/organizations/invitations/audit_logs 对 client SELECT-only 的 GRANT/RLS 边界补全；identity_app 对五张 public 表的 permissive policy 与 grants 按 ADR-0008 补齐。

**Blocked by:** 01 — Schema 基座：profiles / organizations / memberships + RLS/GRANT

**Status:** in-review — [PR #34](https://github.com/wsgbwps/nevix-ai/pull/34)

- [x] migration 过 advisors 与 migration-history 检查
- [x] RLS 集成测试：被邀请人可见自己 email 的 pending 邀请行
- [x] RLS 集成测试：Member 读不到 audit_logs，Owner/Admin 只读
- [x] RLS 集成测试：Membership 终止后即时失权（只读活行天然满足）
- [x] identity_app grants 与 ADR-0008 矩阵一致（audit_logs 无 UPDATE）
- [x] migration 属 CI 门禁路径，走 feature branch + PR


## Comments

- 2026-08-08：实现已提交至 PR #34。`db reset`、lint、advisors、migration history 与声明式零漂移均通过；真实 token 的 RLS 集成测试、`go vet ./...`、`go test ./...`、完整 Mail Smoke 与 `pnpm lint` 均通过。两轴 code review（Standards / Spec）通过。