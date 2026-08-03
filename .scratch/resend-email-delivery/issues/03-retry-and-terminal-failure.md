# 03 — 重试与终态失败

**What to build:** SMTP 故障下的可靠投递语义：Worker 按 1m → 5m → 15m → 1h → 6h 指数退避重试，每条消息最多 5 次；瞬时故障恢复后邮件最终送达；重试耗尽后 Outbox 行置 `failed` 留表不删，作为 V1 唯一的运维可见性（不建告警或重发后台）。SMTP 临时失败不回滚已提交的治理事务。CI 中通过关停/恢复 Mailpit 制造真实 SMTP 故障，退避计划表允许经部署配置压缩以便测试在合理时间内完成——生产配置即定案曲线。

**Blocked by:** 02 — 行走骨架：Outbox 行 → Worker → Mailpit

**Status:** resolved — [PR #10](https://github.com/wsgbwps/nevix-ai/pull/10) 已经 mail-smoke CI（4m32s 全绿）把关并于 2026-08-03 合并入 main

- [x] Mailpit 关停期间写入的 Outbox 行，在 Mailpit 恢复后经重试最终送达（`TestOutboxRowDeliveredAfterMailpitRecovery`：关停期间断言已提交行保持 `pending` 且 `attempts >= 1`，恢复后经重试送达且 `attempts >= 2`）
- [x] 重试次数上限 5 次、间隔符合退避计划表（生产配置为 1m/5m/15m/1h/6h）（判读：初次投递 + 最多 5 次重试 = 6 次投递尝试，5 个退避间隔一一对应 5 次重试前的等待；`TestLoadRetryDelaysDefaultsToProductionSchedule` 钉住生产曲线，`TestRetryExhaustionMarksRowFailedTerminally` 断言 `attempts == 1 + len(delays)` 且每次重试不早于其计划间隔）
- [x] 重试耗尽后行状态为 `failed` 且保留在表中，可用 SQL 直接查出（耗尽测试断言终态 `failed` + `attempts == 6` 且行仍可按 recipient 查出；并断言终态行恢复后不再投递、Worker 继续投递新行）
- [x] SMTP 投递失败不影响已提交的领域状态、Audit Log 与 Outbox 行本身（失败路径在同一会认领事务中提交簿记：真实 SMTP 失败提交 `attempts+1` 与 `next_attempt_at` 或 `failed` 终态；关机取消则回滚、不消耗重试预算；已提交 Outbox 行在故障期间始终可见——Audit Log 尚不存在，随 identity-v1 schema 设计票一并获得可观察对象）
- [x] 测试仅通过 Mailpit 可用性操纵与 Outbox 行状态断言观察，不 mock SMTP、不触碰退避内部计时（可用性操纵 = `docker stop/start` captured-mailbox 容器；观察 = Mailpit HTTP API + `SELECT status, attempts` 行状态轮询；无 fake clock、无私有实现接触）

**实现注记：**

- 「最多 5 次」的判读：ticket 中文「重试次数上限 5 次」+ 退避表恰有 5 个间隔值 → 初次投递 + 5 次重试 = 6 次投递尝试；identity-v1 spec 英文 "at most five attempts" 与之有表述张力，按 ticket 中文实施。实现上 schedule 长度即重试预算：`attempts > len(retryDelays)` 时置 `failed`，单一事实源。
- 退避计划表经新部署变量 `OUTBOX_RETRY_DELAYS`（逗号分隔 Go duration）配置；未设置即生产定案曲线 1m,5m,15m,1h,6h；非法值启动显式失败并点名变量。harness 注入 `1s,2s,3s,4s,5s` 压缩值（`NEVIX_OUTBOX_RETRY_DELAYS`），生产零代码分支。
- 簿记用 DB 时钟：重试调度写 `next_attempt_at = now() + make_interval(secs => $n)`，认领以 DB `now()` 判定到期，Go/DB 时钟漂移不参与调度。
- Mailpit 容器发现按镜像名匹配（CLI 2.110 将容器命名为 `supabase_inbucket_nevix-ai` 但运行 `supabase/mailpit` 镜像），harness 导出 `NEVIX_MAILPIT_CONTAINER`。
- 验证证据（2026-08-03，`./scripts/test-mail-smoke.sh`）：migration `20260803153110_outbox_retry_bookkeeping.sql` 从空库应用通过；恢复测试 2.31s 绿；耗尽测试 18.27s 绿，Worker 日志可见 6 次失败尝试、间隔符合压缩曲线；既有 GoTrue 冒烟、行走骨架、并发不重复投递测试全部保持绿；`supabase db lint --level warning --local` 无错误。

**遗留事项：**

- `migration list` 的本地/远程一致性核对需要 `supabase link` 远程项目，本环境未 link；`db reset` 从空库应用已在 harness 中验证，远程核对留待 PR/运维环节。
- 恢复测试存在已知时间窗口：首次失败记录后须在剩余重试预算（压缩曲线下约 15s）内完成 `docker start` + Mailpit 就绪，实测 <3s；CI 极端缓慢时理论上可能偶败，届时行会耗尽为 `failed` 而非送达。
- 票 02 遗留的 GRANT/RLS 最小权限角色、identity-v1 schema 设计票对本表 expand 吸收，均不变。
