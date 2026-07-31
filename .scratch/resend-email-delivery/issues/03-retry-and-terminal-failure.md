# 03 — 重试与终态失败

**What to build:** SMTP 故障下的可靠投递语义：Worker 按 1m → 5m → 15m → 1h → 6h 指数退避重试，每条消息最多 5 次；瞬时故障恢复后邮件最终送达；重试耗尽后 Outbox 行置 `failed` 留表不删，作为 V1 唯一的运维可见性（不建告警或重发后台）。SMTP 临时失败不回滚已提交的治理事务。CI 中通过关停/恢复 Mailpit 制造真实 SMTP 故障，退避计划表允许经部署配置压缩以便测试在合理时间内完成——生产配置即定案曲线。

**Blocked by:** 02 — 行走骨架：Outbox 行 → Worker → Mailpit

**Status:** ready-for-agent

- [ ] Mailpit 关停期间写入的 Outbox 行，在 Mailpit 恢复后经重试最终送达
- [ ] 重试次数上限 5 次、间隔符合退避计划表（生产配置为 1m/5m/15m/1h/6h）
- [ ] 重试耗尽后行状态为 `failed` 且保留在表中，可用 SQL 直接查出
- [ ] SMTP 投递失败不影响已提交的领域状态、Audit Log 与 Outbox 行本身
- [ ] 测试仅通过 Mailpit 可用性操纵与 Outbox 行状态断言观察，不 mock SMTP、不触碰退避内部计时
