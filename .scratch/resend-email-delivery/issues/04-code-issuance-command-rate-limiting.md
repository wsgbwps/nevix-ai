# 04 — 验证码签发命令与命令层限流

**What to build:** 第一条真实的验证码签发路径：`internal/identity` 暴露一条最小外部命令（作为 expand 移动保持最小，接口形状留待 identity-v1 可信命令接口设计票吸收），签发六位一次性码、哈希落库、写 Outbox 行发出携码邮件。限流与冷却在命令层同步判定：60 秒重发冷却、同一邮箱每小时最多 5 条、IP 级限制、新码作废旧码；超限命令被同步拒绝并返回明确错误，不写领域状态、不写 Outbox 行。与 GoTrue 的限流池完全独立，互不读取计数。

**Blocked by:** 02 — 行走骨架：Outbox 行 → Worker → Mailpit

**Status:** ready-for-agent

- [x] 经外部命令签发验证码后，携六位码的邮件出现在 Mailpit（`TestIssuedCodeEmailArrivesInMailpit`：202 后经 Worker 投递，正文提取六位码与库中 active 行哈希互证）
- [x] 服务端只存码的哈希，日志与响应中不出现明文码（库中 `code_hash` 断言等于邮件码的 HMAC；响应体断言不含明文码；明文只存在于 Outbox 行 body，代码路径不记日志）
- [x] 60 秒冷却内的第二次请求被同步拒绝，且 Mailpit 无第二封邮件、Outbox 无新行（`TestResendWithinCooldownIsRejected`：429 `cooldown_active` + `Retry-After`；Outbox 计数为 1 即不存在第二封邮件的来源，Worker 只投递 Outbox 行）
- [x] 同一邮箱一小时内第 6 次请求被拒绝；IP 级限制独立生效（`TestSixthCodeRequestWithinHourIsRejected`：种子 5 条窗口内历史后第 6 次 429 `email_rate_limited`；`TestIPRateLimitAppliesIndependently`：种子 20 条同 IP 历史后新邮箱 429 `ip_rate_limited`，换 IP 即 202）
- [x] 重发成功后旧码立即作废，新码可用（`TestResendSupersedesPreviousCode`：旧码行 `superseded` 且 `superseded_at` 非空，唯一 active 行哈希与最新邮件中的码一致；本切片无验证端点，「可用」以行状态闭环，见实现注记）
- [x] 命令拒绝语义只经外部命令接口断言，不触碰限流私有实现（拒绝断言全部经 HTTP 状态与响应体；签发历史种子经事务写入缝——票 02 先例的同一道缝，断言仍只走外部命令/Mailpit/行状态三条已定缝）

**实现注记：**

- 外部命令形状（最小 expand 移动）：`POST /identity/verification-codes`，请求 `{"email": "..."}`；接受返回 202 `{"status":"issued"}`；拒绝返回 429 与机读错误码（`cooldown_active` 附 `Retry-After` 头、`email_rate_limited`、`ip_rate_limited`）。首个 `module.go`/`Register(r chi.Router, bus event.Bus)` 随本票落地（票 02 遗留事项），接口形状留待 identity-v1 可信命令接口设计票吸收。
- 限流数值：60 秒冷却与每邮箱每小时 5 条为 spec 定案；IP 级限流数值 spec 留白，经 spec 作者拍板为**每 IP 每小时 20 条**。三个参数为命令层命名常量，不做部署配置——测试经事务写入缝种子签发历史（`created_at` 回填）在秒级完成，无需压缩窗口。
- 只存哈希：HMAC-SHA256，胡椒为新部署变量 `VERIFICATION_CODE_HASH_KEY`（六位码熵仅约 20 bit，裸 SHA-256 在库泄漏时可秒级穷举，经拍板引入）。
- 发件人：新部署变量 `SMTP_FROM`（spec 四变量之外的第五变量，经拍板）——发件人依赖部署侧已验证的发信域名，属部署数据而非代码。两个新变量缺失即启动显式失败并点名，沿用 SMTP 四变量契约；harness 注入 `NEVIX_VERIFICATION_CODE_HASH_KEY` / `NEVIX_SMTP_FROM`。
- 单事务同步判定：先取每邮箱、每 IP 两个 `pg_advisory_xact_lock`（固定 email→IP 顺序，避免死锁）串行化并发签发，使冷却与限额在并发下成立；判定（冷却取 `max(created_at)`、窗口计数用 DB 时钟）→ 作废旧码 → 插新码哈希 → 写 Outbox 行同事务提交；拒绝路径在任何写入前返回，零领域状态、零 Outbox 行。
- schema：`identity.verification_codes` 声明式入 `supabase/schemas/identity.sql`，migration `20260803091438_verification_codes.sql` 由 `db diff --use-pg-delta` 生成；每行签发记录即限流计数事实源（email/request_ip 双时间索引）。生成时间戳为 UTC（票 03 为本地时间，同日内排序交错但两迁移无依赖）；`db reset` 从空库应用、`db lint --level warning --local` 无错误、`migration list --local` 一致均已验证。
- 与票 05 的边界：本票作废只改 code 行；仍 pending 的携旧码邮件继续重试送达是**已知行为**——携码邮件的重试地平线、码失效即刻终态属票 05（本票测试中第一封邮件均已送达，不覆盖该窗口）。
- chi 与 `pkg/event.InMemoryBus`：`Register(r chi.Router, bus event.Bus)` 是 server/AGENTS.md 的 Module 契约，组合根必须构造具体总线，故在共享区落地最小内存实现（同步分发、无订阅者零行为）；共享区变更的影响与测试在 PR 描述声明，`bus_test.go` 直接覆盖。
- 验证证据（2026-08-03，`./scripts/test-mail-smoke.sh` 两次全绿，末次 1m51s）：5 条新集成测试 + 2 条新配置单测全绿，既有 GoTrue 冒烟、行走骨架、重试/终态失败、并发不重复投递全部保持绿；`go build`/`go vet`/`gofmt` 干净。

**遗留事项：**

- 票 02 遗留的 GRANT/RLS 最小权限角色、identity-v1 schema 设计票对两张表的 expand 吸收，不变。
- 接口形状（路径/字段/错误码）为最小 expand 移动，identity-v1 可信命令接口设计票吸收时可能调整；根 `contracts/openapi.yaml` 暂保持为空——本端点尚无客户端消费，形状固化待吸收时一并处理。
- identity 模块源文件增至 6 个（仍属 ADR-0003 简单 Module 档）；若继续膨胀，按 ADR-0003 显式评估是否上四层。
- IP 限流按连接对端地址判定，不读转发头（V1 无可信反代）；未来部署形态引入反代时需重审。
