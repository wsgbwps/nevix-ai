# 05 — 携码邮件的重试地平线

**What to build:** 验证码语义与投递重试的交汇规则：携带一次性码的邮件，其重试地平线不超过该码的剩余有效期；码被新码作废或自然过期时，对应邮件立即终态、停止重试——用户永远不会收到一封已经无效的验证码邮件。终态原因可从 Outbox 行状态区分（投递耗尽 vs 码失效）。

**Blocked by:** 03 — 重试与终态失败；04 — 验证码签发命令与命令层限流

**Status:** ready-for-agent

- [x] SMTP 故障期间用户重发获得新码后，携旧码的邮件不再重试并进入终态（`TestSupersededCodeEmailStopsRetrying`：停 Mailpit 重试中重发，签发事务同事态将旧邮件置 `cancelled`；恢复后仅新码邮件送达且其哈希与唯一 active 码行互证，旧行保持 `cancelled`、新行 `delivered`）
- [x] 码自然过期后，其未送达邮件立即终态，不再占用重试（`TestExpiredCodeEmailGoesTerminal`：有效期经写入缝回填至 2.5 秒后，跨一次地平线内重试命中调度截断；终态 `cancelled` 后 attempts 冻结，恢复 Mailpit 零送达）
- [x] 码仍有效且 SMTP 恢复时，重试照常送达（`TestValidCodeEmailDeliveredAfterRecovery`：携码邮件经重试 `delivered`，attempts≥2，邮件码与 active 行互证——不误伤正常路径）
- [x] Outbox 行终态可区分"重试耗尽"与"码失效"两种原因（`failed` 与 `cancelled` 为 CHECK 约束中两个独立终态值；耗尽路径由票 03 `TestRetryExhaustionMarksRowFailedTerminally` 保持绿，码失效路径由本票两条测试覆盖）
- [x] 测试仅经外部命令接口、Mailpit 与 Outbox 行状态三条缝断言（断言全部经 HTTP 命令/Mailpit HTTP API/行状态；冷却绕过与过期构造经票 04 先例的事务写入缝，零新缝、零 mock、不触 Worker 私有实现）

**实现注记：**

- 两个拍板（经 spec 作者确认，已回写 resend-email-delivery spec 与 identity-v1 spec）：验证码有效期 **10 分钟**（identity-v1 spec 留白，命令层命名常量，同限流常量先例不做部署配置）；码失效终态命名 **`cancelled`**（与重试耗尽的 `failed` 并列为 Outbox 行两个终态失败值）。
- schema：`outbox_messages.verification_code_id` 可空 FK 关联携码邮件与码（非携码邮件为 NULL，行为完全不变）；`verification_codes.expires_at NOT NULL`；status CHECK 加 `cancelled`。声明式入 `supabase/schemas/identity.sql`，migration `20260803120613_code_validity_retry_horizon.sql` 由 `db diff --use-pg-delta` 生成；码表定义前移至 Outbox 表之前是 FK 引用所需。版本号数字上早于票 03 的 153110（生成时区差异，票 03/04 已有同日内交错先例），两迁移无依赖；`db reset` 空库重放、`db lint --level warning` 无错误、`migration list` 一致均已验证。
- 三层规则，各管一段：**命令层**签发事务在作废旧码前将其 pending 携码邮件置 `cancelled`（"新码作废旧码"同步判定的延伸，作废场景立即终态的真源）；**Worker 认领时**检查携码行的码仍可用（active 且未过期，DB 时钟判定），否则置 `cancelled` 不投递、不消耗重试预算（覆盖自然过期与一切漏网）；**Worker 重试调度时截断**——下一次重试将落在码剩余有效期之外则直接 `cancelled` 而非调度，使"立即终态"在生产 15m/1h/6h 退避下严格成立（已过期码的行不会挂 pending 数小时）。截断判定用认领查询同 SELECT 的 `now()` 与 `expires_at`，不碰进程时钟。
- 认领查询改 `FOR UPDATE OF m SKIP LOCKED`：LEFT JOIN 后限定只锁 Outbox 行，命令层作废事务与 Worker 认领互不阻塞。
- 双轴 code-review：Standards 轴无硬违规（CONTEXT.md 的 Outbox Worker 术语定义已同步携码地平线语义；测试复用既有 `outboxRowState` 类型）；Spec 轴指出"过期终态非严格立即"，经重试调度截断修复后复审通过。
- 验证证据（2026-08-03，`./scripts/test-mail-smoke.sh` 全绿）：14 个测试全过——3 条新集成测试（2.34s/7.85s/2.32s），既有 GoTrue 冒烟、行走骨架、重试/终态失败、并发不重复投递、票 04 签发与限流全部保持绿；`go build`/`go vet`/`gofmt` 干净。

**遗留事项：**

- 票 02 遗留的 GRANT/RLS 最小权限角色、identity-v1 schema 设计票对两表（含本票新增一列、一 FK、一约束值）的 expand 吸收，不变。
- Worker 已认领且投递在途的携码邮件遇上同时刻重发，属 SMTP 不可撤回的固有竞态窗口；终态契约不受影响（已 delivered 的行不被 retroactively 改写）。
