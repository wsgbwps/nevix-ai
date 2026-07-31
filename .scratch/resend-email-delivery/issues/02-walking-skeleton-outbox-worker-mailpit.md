# 02 — 行走骨架：Outbox 行 → Worker → Mailpit

**What to build:** 第一条穿透全层的投递路径：一个事务性 Outbox 行被 `internal/identity` module 内的 Outbox Worker 认领并经标准 SMTP 投递到 Mailpit。包含最小 outbox 声明式 schema 与 migration（作为 expand 移动保持最小，留待 identity-v1 schema 设计票吸收）、module 骨架、随主进程启停的 Worker goroutine（`FOR UPDATE SKIP LOCKED` 轮询、优雅关闭）、`wneessen/go-mail` 直接投递（不包自建接口）、组合根仅做拉起与关闭 wiring。启动时校验 SMTP host/port/user/password 四个部署变量，缺失即显式失败——生产切到 Resend 的 SMTP 端点时代码零分支。

**Blocked by:** 01 — 邮件测试 harness 与 GoTrue SMTP 冒烟

**Status:** ready-for-agent

- [ ] 最小 outbox 声明式 schema 与 migration 从空库应用通过，advisors 与 migration-history 检查绿
- [ ] 在同一数据库事务中写入 Outbox 行并提交后，邮件出现在 Mailpit
- [ ] Worker 随主进程启动，收到关闭信号后优雅退出，不留半投递状态
- [ ] 并发两个轮询者不重复投递同一行（SKIP LOCKED 语义）
- [ ] 缺失任一 SMTP 变量时进程启动显式失败并说明缺哪个
- [ ] identity Worker 与 GoTrue 的邮件落在同一个 Mailpit 收件箱
- [ ] 测试只经事务写入缝与 Mailpit 断言，不触碰 Worker 私有实现、不 mock SMTP
