# Verify the Supabase Platform Baseline

Type: research
Status: resolved
Blocked by: none
Research branch: `research/identity-supabase-baseline`

## Question

基于当前 Supabase 官方文档与 changelog，哪些精确版本、配置和兼容性事实必须进入 Identity V1 spec：ES256/JWKS、自托管 Auth URL、publishable/secret keys、Session timeout、SMTP、声明式 schema/migrations、CLI advisors，以及 external PostgreSQL 约束？

## Answer

Identity V1 将以下事实作为平台基线：

- 所有环境显式使用 ES256/P-256；Go 从公开 JWKS 按 `kid` 验证，不提供 HS256 回退。
- `API_EXTERNAL_URL` 必须包含且只包含一次 `/auth/v1`，并同时作为 JWT issuer 基址。
- Desktop 只获得 publishable key；secret key 仅在真实 Auth Admin 用例中进入可信 Go。
- access token 基线为一小时；Session time-box、inactive timeout 和注销的严格生效时间必须按 refresh/JWT 语义测试，敏感命令若要求立即拒绝需额外验证 `session_id`。
- 本地与 CI 邮件进入 Mailpit；生产样环境必须使用 custom SMTP。
- `supabase/schemas/` 是期望状态，审查后的 migrations 是部署记录；CI 固定 CLI 版本、从空库重放、运行 advisors 并核对 migration history。
- external PostgreSQL wiring 不等于阿里云 RDS 兼容保证，必须经过独立基础设施 gate。

完整引用研究资产位于 `research/identity-supabase-baseline` 分支，commit `1116c2419f19082422fbdb8f99a5c30ab557dcaf` 的 `.scratch/identity-v1/research/supabase-platform-baseline.md`。
