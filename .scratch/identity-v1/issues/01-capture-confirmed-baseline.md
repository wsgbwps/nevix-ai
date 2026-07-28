# Capture the Confirmed Identity V1 Baseline

Type: task
Status: resolved
Blocked by: none

## Question

将本次 grilling 已确认的产品、领域、安全和架构决定逐条固化到 `.scratch/identity-v1/spec.md`，以 `apps/desktop/CONTEXT.md`、ADR-0004 和会话决定为来源；标出矛盾或遗漏，但不发明新答案。哪些已确认决定构成后续 tickets 不应重复讨论的 baseline？

## Answer

[Identity V1 Spec](../spec.md) 已固化本次 grilling 确认的 baseline：

- Organization-as-tenant、单一 Owner、Membership/Invitation、删除状态、Audit Log、Profile 与 Session 的领域行为。
- 邮箱密码认证、验证码、重新认证、Email Change、Security Lock 与通知矩阵。
- Membership 作为实时授权事实源，以及 Supabase 数据平面 + Go 可信执行 seam。
- 私有 `server/internal/identity`、无 `pkg/auth` 和无假想 adapter 的最小 module 形状。
- 声明式 schema/migration、ES256/JWKS、公开/秘密凭据和环境配置边界。
- Desktop UI Block、无路由/深链、`safeStorage` 与 Electron 安全基线。
- SMTP/Outbox、三个 vertical slice、临时 Supabase 集成测试与阿里云 RDS 独立 gate。

Spec 同时明确列出仍需由后续 tickets 解决的 gaps，没有为密码政策、User Deletion 恢复 Membership、schema/RLS、命令 interface、UI 状态、Outbox retry、ADR 或验收 gate 发明答案。

当前仓库的空 `server/pkg/auth/.gitkeep` 与 V1“不创建 `pkg/auth`”方向不一致，已作为实施前需要显式处理的现状记录；它不改变已确认 module 边界。
