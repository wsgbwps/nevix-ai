# Identity V1 Wayfinding Map

Label: wayfinder:map
Status: superseded as the active development map

当前开发入口已迁移到 [Authentication Foundation Wayfinding Map](../authentication-foundation/map.md)。本地图保留为长期 Identity 方向与既有研究的历史参考；不要继续领取或推进这里尚未解决的 tickets。后续阶段只在前一阶段完成并获得真实反馈后，按需建立新的小地图。

## Destination

产出一份可直接交给后续 agent 实施的 Identity V1 完整规格与决策地图：覆盖三个 vertical slice 的领域行为、Supabase schema/RLS、Desktop/Go interface、Session/邮件/审计安全、迁移与验收标准，并关闭所有实施前决策。阿里云 RDS 只产出独立基础设施验证入口，不实际接入或迁移。

## Notes

- Primary Domain: `identity`
- 每次处理 ticket 前阅读 `AGENTS.md`、`docs/adr/0004-supabase-go-trusted-execution-seam.md`、`CONTEXT-MAP.md` 和 `apps/desktop/CONTEXT.md`。
- 每次 session 使用 `grilling` 与 `domain-modeling`；涉及实现形状时使用 `karpathy-guidelines`，涉及 Supabase/PostgreSQL 时使用 `supabase` 与 `supabase-postgres-best-practices`，涉及 module interface 时使用 `codebase-design`。
- Research ticket 使用 `research`，prototype ticket 使用 `prototype`。
- Wayfinding 只产出决策与 handoff spec，不实施功能代码。
- V1 保持一个私有 `server/internal/identity` module；没有第二个真实消费者前不创建 `pkg/auth` 或假想 adapter interface。
- 计划交付顺序为 Identity Foundation、Organization Membership、Identity Governance 三个可独立合并和回滚的 vertical slice。

## Decisions so far

- [Capture the Confirmed Identity V1 Baseline](./issues/01-capture-confirmed-baseline.md) — 已将 grilling 确认的领域、产品、安全、架构与非目标固化到 working spec，并保留未决 gaps。
- [Verify the Supabase Platform Baseline](./issues/02-verify-supabase-platform-baseline.md) — 固定 ES256/JWKS、Auth URL、公开/秘密凭据、Session、SMTP、声明式 migration 与 CLI 验收基线。
- [Define the Alibaba RDS Compatibility Gate](./issues/10-define-alibaba-rds-gate.md) — 当前为 conditional no-go，只有生产等价 RDS 完整通过基础设施与端到端 gate 才可放行。
- [Verify the Integration Test Harness](./issues/09-verify-integration-test-harness.md) — 用固定版本的临时 Supabase/Mailpit、真实 token、Go 与 Electron Playwright 构成主 CI，并把 native/生产环境证据拆为独立 smoke gates。
- [Finalize the Authentication Policy](./issues/03-finalize-authentication-policy.md) — 固定 UTF-8 字节密码规则、无账号锁定/CAPTCHA、精确限流与枚举防护，以及邮箱为唯一信任根的恢复和 Session 撤销语义。

## Not yet specified

- 当 schema、命令和 UI 状态更具体后，是否需要额外的运营支持或异常恢复工具。
- 各 vertical slice 的可观测性信号与告警范围，需等待失败模式清晰后再决定。
- 目标 spec 的最终章节形状，需等待各决策 ticket 的产物稳定后再收敛。

## Out of scope

- 实施功能代码、schema、migration、云资源或三个 implementation PR。
- V1 实际接入或迁移阿里云 RDS。
- Edge Functions、社交登录、Magic Link、SAML SSO、SCIM、MFA、自定义角色和细粒度权限。
- 活动设备列表、远程单设备撤销、手动“退出其他所有设备”和 Membership 暂停。
- Electron 自定义协议、通用深链、通用网页前端和前端路由库。
- 完整行为分析、计费实现、AI 任务和业务文件状态。
