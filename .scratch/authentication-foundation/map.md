# Authentication Foundation Wayfinding Map

Label: wayfinder:map

## Destination

产出一份可直接交付实施的 Authentication Foundation handoff：让 Desktop 用户完成邮箱密码注册、六位验证码验证、登录、密码恢复、安全 Session 恢复与当前设备退出，并以真实集成测试证明闭环。完成后停止，不提前设计 Profile、Organization、Membership 或治理能力。

## Notes

- Primary Domain: `identity`
- 当前代码中尚无 Supabase SDK、Identity Feature 或 Auth 集成，因此从最小端到端闭环开始。
- 使用现有 [Authentication Policy](../identity-v1/issues/03-finalize-authentication-policy.md)、[Supabase Platform Baseline](../identity-v1/issues/02-verify-supabase-platform-baseline.md) 与 [Integration Test Harness](../identity-v1/issues/09-verify-integration-test-harness.md) 中仅和本阶段相关的已确认结论，不重新讨论。
- 每次 session 使用 `grilling` 与 `domain-modeling`；实现遵循 `karpathy-guidelines`，Supabase 工作遵循 `supabase`。
- Wayfinding 只产出决策与 handoff，不实施功能代码。
- Agent 采用合理默认值，只有会明显改变产品体验的分岔才一次询问一个问题。
- UI prototype 只进行一次低保真反应回合；确认主要状态后立即进入 handoff，不追求视觉定稿。
- 本阶段作为一个 Desktop 主导的 cohesive vertical slice 实施；不引入 Go 身份 module、业务 schema、RLS 或通用共享 Auth 抽象。
- Authentication Foundation 实施并验证后，才为下一阶段建立新的小地图。

## Decisions so far

- [Reframe Identity Delivery as Just-in-Time Vertical Slices](./issues/01-reframe-identity-delivery.md) — Identity 按可运行、可验证、可合并的阶段推进，当前只规划 Authentication Foundation。

## Not yet specified

无。当前唯一尚未解决的问题已明确成为 frontier ticket。

## Out of scope

- Profile、头像与公开用户资料。
- First Organization、Active Organization 及任何业务资源归属。
- Membership、Invitation、多 Organization、角色和成员治理。
- Ownership Transfer、Organization/User Deletion、Email Change 与 Security Lock。
- Organization Audit Log、自管 Outbox 与完整通知矩阵。
- Identity 业务 schema、RLS/GRANT 矩阵和 `server/internal/identity`。
- 阿里云 RDS 验证、生产基础设施、运营工具和完整可观测性。
- 社交登录、Magic Link、MFA、SAML SSO、SCIM、匿名登录和通用深链。
