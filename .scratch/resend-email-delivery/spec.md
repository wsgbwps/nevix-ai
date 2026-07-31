# Resend Email Delivery via Standard SMTP

Status: ready-for-agent

来源：2026-07-31 grill-with-docs 会话，对照 `.scratch/identity-v1/spec.md` Email and Outbox 章节定案。该章节的重试计划表与终态失败行为已随本设计写回 identity-v1 spec；本 spec 是可实施的交付契约。

## Problem Statement

Identity V1 的邮件行为目前只对 captured mailbox 成立：本地和 CI 里 GoTrue 与 `internal/identity` 的邮件都进 Mailpit，但生产环境还没有任何真实投递能力。用户注册收不到验证码、受邀者收不到 Invitation 码、Owner 收不到 Ownership Transfer 与安全通知——整条 Identity 治理链路在生产上无法闭环。同时，验证码的限流、冷却与失败重试的实现位置此前是留白，实现者被 spec 的"不许猜"禁令卡住。

## Solution

以 Resend（服务商）作为生产邮件投递方，通过其标准 SMTP 端点接入，不引入 HTTP SDK。GoTrue 与 identity 的 Outbox Worker 走同一条标准 SMTP 路径，生产/本地/CI 的差异只体现为部署配置中的四个 SMTP 变量；换服务商不改代码。验证码的限流、冷却、新码作废旧码在 `internal/identity` 命令层同步判定并即时反馈给用户；Outbox Worker 是纯投递器，按固定退避曲线重试，耗尽后留下 `failed` 行作为 V1 唯一的运维可见性。

## User Stories

1. As a registering user, I want 注册后收到真实邮箱里的六位验证码, so that 我能在 Desktop 完成注册验证。
2. As a user recovering a password, I want 密码找回码送达我的真实邮箱, so that 我能在忘记密码时恢复账户。
3. As a user changing my email, I want 新邮箱收到验证码、旧邮箱收到 Security Lock 通知, so that 换绑既可完成又可被我本人否决。
4. As an invited person, I want 收到含 Invitation 接受码的邮件, so that 我能加入目标 Organization。
5. As an Owner or Admin, I want 重发 Invitation 时旧码立即作废、新码送达, so that 被转发的旧邮件无法被冒用。
6. As a target Admin of an Ownership Transfer, I want 在 24 小时窗口内收到接受码, so that 我能确认接任 Owner。
7. As an Owner deleting an Organization, I want 删除相关的治理邮件可靠送达, so that 成员对 Organization Deletion 有知情记录。
8. As a user, I want 60 秒冷却内的重发码请求被同步拒绝并给出明确错误, so that 我知道该等待而不是怀疑系统坏了。
9. As a user, I want 同一邮箱一小时内最多收到 5 条 identity 验证码, so that 我的邮箱不被轰炸、我的账户不被暴力骚扰。
10. As an attacker-facing system, I want IP 级限流在命令层同步生效, so that 单一来源无法批量触发验证码发送。
11. As a user whose governance command succeeded, I want SMTP 临时故障不回滚我已完成的操作, so that 邮件问题不会撤销我的 Invitation 或 Transfer。
12. As a recipient behind a flaky mail path, I want 系统按 1m/5m/15m/1h/6h 退避重试最多 5 次, so that 瞬时故障不会让我永远收不到邮件。
13. As a user who requested a new code, I want 携带已作废旧码的邮件立即停止重试, so that 我不会收到一封已经无效、徒增困惑的邮件。
14. As an operator, I want 重试耗尽的 Outbox 行以 `failed` 状态留在表里, so that 我能用一条 SQL 查清生产投递失败的全部记录。
15. As an operator, I want 生产切换或更换邮件服务商时只改 SMTP host/port/user/password 四个部署变量, so that 供应商变更零代码、零发版风险。
16. As a deployer, I want GoTrue 的邮件限流由其内建部署配置兜底, so that 不需要 identity 去感知或代理 GoTrue 的发送。
17. As a developer, I want 本地 `supabase start` 自带的 Mailpit 同时捕获 GoTrue 与 identity 两条路径的邮件, so that 我不用额外起容器就能端到端看邮件。
18. As a CI pipeline, I want 对着版本钉定的 Supabase 栈内 Mailpit 断言邮件行为, so that 邮件契约可重复验证且不外发真实邮件。
19. As a developer, I want Outbox Worker 随主进程 goroutine 启停并优雅关闭, so that 不需要维护第二个部署单元。
20. As a future maintainer, I want 限流规则只存在于命令层、Worker 只懂投递, so that 两个关注点可以独立演进互不污染。

## Implementation Decisions

- **接入方式**：Resend（服务商）仅通过标准 SMTP 端点（`smtp.resend.com`，用户名 `resend`，密码即 API Key）接入。不引入 resend-go SDK，不建 provider 适配器接口（维持 identity-v1 spec 第 365 行）。不获取 message ID，不接送达 webhook。
- **单一路径**：GoTrue 与 Outbox Worker 走同一条标准 SMTP 路径；环境差异 = `SMTP_HOST/PORT/USER/PASSWORD` 四个部署变量，代码零分支。
- **限流边界**：两个独立限流池。GoTrue 系（注册/找回/换邮箱）由 GoTrue 内建限流部署配置兜底（等效 5 条/小时 + 冷却）；identity 系（Invitation 接受、Ownership Transfer 接受）由 `internal/identity` 自行强制：60 秒重发冷却、每邮箱每小时 5 条、IP 级限制。两池互不读取对方计数。
- **限流位置**：全部限流、冷却与新码作废旧码在 `internal/identity` 命令处理层**同步**判定；超限则拒绝命令，不写领域状态、不写 Outbox 行，用户即时收到明确错误。
- **Outbox Worker**：`internal/identity` module 内部的后台 goroutine，组合根只做拉起与优雅关闭；用 `SELECT ... FOR UPDATE SKIP LOCKED` 轮询认领，天然支持未来多副本。纯投递器，不含任何业务规则。
- **重试与终态**：指数退避 1m → 5m → 15m → 1h → 6h，每条消息最多 5 次。携带一次性验证码的邮件，重试地平线不超过码的剩余有效期；码作废或过期即刻终态。耗尽后行状态置 `failed` 留表不删；不建告警或重发后台。
- **不回滚原则**：SMTP 临时失败不回滚已完成的治理命令；领域状态、Audit Log、Outbox 行仍在同一事务提交（维持既有契约）。
- **SMTP 客户端**：Worker 使用 `wneessen/go-mail`（标库 `net/smtp` 已冻结，缺 context 取消与隐式 TLS 支持），直接调用、不包自建接口。
- **捕获邮箱**：本地与 CI 均使用 Supabase 栈自带 Mailpit；GoTrue 默认已接入，identity Worker 的 SMTP 配置指向同一实例，两条路径在同一收件箱断言。
- **术语**：Resend（服务商）与「重发码」（重新签发验证码的动作）严格区分，已录入 server 上下文词汇表（Outbox、Outbox Worker 同批录入）。

## Testing Decisions

好的测试只断言外部行为：命令被接受或拒绝、邮件是否出现在收件箱、Outbox 行的终态。退避曲线的内部计时、go-mail 调用、goroutine 轮询均为私有实现，不被任何测试直接触碰，不 mock SMTP。

三条测试缝，全部为 identity-v1 既有缝，零新缝：

1. **`internal/identity` 外部命令/HTTP 接口**——发起治理命令（创建/重发 Invitation、发起 Ownership Transfer），断言限流与冷却的同步拒绝语义（超限命令被拒且不产生 Outbox 行）。
2. **Captured mailbox（Mailpit HTTP API）**——断言邮件送达、冷却窗口内无第二封、GoTrue 与 identity 两路径落同一收件箱。
3. **Outbox 表行状态**——`failed` 留表是 V1 声明的运维可见性契约，属外部行为；通过关停/恢复 Mailpit 制造 SMTP 故障，断言重试后送达或耗尽后 `failed`。

被测对象：`internal/identity` module（命令层限流 + Outbox Worker 投递）；GoTrue 侧仅做部署配置的 CI 冒烟（邮件落 Mailpit），不测 GoTrue 内部。

先例：identity-v1 spec「Verification strategy」——Go 测试跨 `internal/identity` 外部命令/HTTP 接口验证事务、Audit Log 与 Outbox，不测私有实现；CI 用版本钉定的临时 Supabase/PostgreSQL 栈 + captured mailbox，从空库应用已提交 migration 起步。

## Out of Scope

- 模板清单与通知矩阵（identity-v1 ticket 08 的剩余未决部分）
- 告警、重发后台、投递看板等超出 `failed` 留表的运维可见性（identity-v1 spec 明确留白）
- Resend HTTP API、SDK、送达/退信 webhook
- provider 适配器接口或任何多服务商抽象
- GoTrue 系与 identity 系验证码的全局统一限流计数
- 独立 worker 进程或部署单元
- Resend 账户开通、发信域名 DNS（SPF/DKIM）配置等部署侧运维操作
- Alibaba RDS 相关的一切（另有基础设施 gate）

## Further Notes

- 本 spec 是高风险认证域切片，须走 feature branch + PR，CI 与 diff review 把关（仓库交付规则）。
- `.scratch/identity-v1/spec.md` 第 368/455 行的重试留白已随本设计收窄为"模板清单与超出留表的运维可见性仍开放"；实现时不再触碰"不许猜"禁令。
- identity-v1 ticket 08（Email and Outbox Contract）与本 spec 部分重叠：发送、重试、失败可见性、捕获邮箱已由本 spec 定案，08 剩余模板清单与通知矩阵，已在该票追加评论指向此处。
- 生产上线前置条件：Resend 发信域名验证完成、四个 SMTP 变量进入部署配置；这属于运维动作，不阻塞本 spec 的代码实现与 CI 验证。
