# Reframe Identity Delivery as Just-in-Time Vertical Slices

Type: grilling
Status: resolved
Blocked by: none

## Question

在注册登录尚未实现、代码库也没有 Supabase Auth 集成的情况下，Identity 是否仍应一次性关闭完整 schema、RLS、Organization、Membership、治理、审计、Outbox 与生产基础设施决策；还是应按真实开发反馈拆成阶段，每次只规划并实施下一个可运行闭环？

## Answer

采用 just-in-time 的阶段化交付，不再把完整 Identity V1 handoff 当作注册登录实现的前置条件。

### 阶段顺序

1. **Authentication Foundation（当前）**
   - 邮箱密码注册、六位验证码验证、登录、密码恢复。
   - Session 在 Desktop 重启后安全恢复，当前设备可退出。
   - 未认证用户不能进入 app shell。
   - 只接入 Supabase Auth；不创建 Profile、Organization、业务 schema 或 Go 身份 module。

2. **First Organization**
   - 在 Authentication Foundation 实际运行后，再加入全局 Profile、首个 Organization、Owner Membership 与 Active Organization。
   - 只设计这些行为真正需要的最小 schema、RLS 和原子可信命令。

3. **Organization Membership**
   - 再加入 Invitation、多 Organization 切换、Owner/Admin/Member 权限、成员退出和移除。
   - 只随这些用例扩展 RLS、审计事件与邮件可靠性。

4. **Identity Governance**
   - 最后加入 Ownership Transfer、Organization/User Deletion、Email Change、Security Lock 及完整 Audit Log/Outbox。
   - 这些复杂安全状态以此前阶段暴露的真实失败模式和运营需求为输入。

5. **Production Readiness**
   - 在准备进入预发布或生产时执行阿里云 RDS compatibility gate、环境演练、告警和恢复验证。
   - 基础设施兼容性不阻塞本地 Authentication Foundation 开发。

### 推进规则

- 每个阶段依次完成：最小决策、实现、自动化验证、人工走查、合并、真实反馈。
- 前一阶段未完成前，不领取下一阶段的决策 tickets。
- 已完成的 Supabase、安全与测试研究作为约束复用；超出当前阶段的结论保留为参考，不强迫当前实现承载。
- 每阶段只创建能独立构建、测试、合并和回滚的 cohesive vertical slice。
- 不因为“以后可能需要”预建 schema、adapter、公共 interface、恢复工具或治理状态。

这一顺序把用户当前需要思考的范围限制为眼前可体验的产品行为，同时让架构复杂度由真实用例逐步赚取。
