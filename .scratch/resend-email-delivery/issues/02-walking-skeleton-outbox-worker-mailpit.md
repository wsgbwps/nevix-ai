# 02 — 行走骨架：Outbox 行 → Worker → Mailpit

**What to build:** 第一条穿透全层的投递路径：一个事务性 Outbox 行被 `internal/identity` module 内的 Outbox Worker 认领并经标准 SMTP 投递到 Mailpit。包含最小 outbox 声明式 schema 与 migration（作为 expand 移动保持最小，留待 identity-v1 schema 设计票吸收）、module 骨架、随主进程启停的 Worker goroutine（`FOR UPDATE SKIP LOCKED` 轮询、优雅关闭）、`wneessen/go-mail` 直接投递（不包自建接口）、组合根仅做拉起与关闭 wiring。启动时校验 SMTP host/port/user/password 四个部署变量，缺失即显式失败——生产切到 Resend 的 SMTP 端点时代码零分支。

**Blocked by:** 01 — 邮件测试 harness 与 GoTrue SMTP 冒烟

**Status:** resolved — PR #9 经 CI 把关合并；合并后完成真实 Resend 端到端手动冒烟（证据见文末补记）

- [x] 最小 outbox 声明式 schema 与 migration 从空库应用通过，advisors 与 migration-history 检查绿（`supabase/schemas/identity.sql` → `supabase/migrations/20260731101206_outbox_walking_skeleton.sql`；`db reset` 从空库应用、`db lint --level warning` 无错误、`migration list` 本地/历史一致）
- [x] 在同一数据库事务中写入 Outbox 行并提交后，邮件出现在 Mailpit（`TestCommittedOutboxRowIsDeliveredToMailpit`）
- [x] Worker 随主进程启动，收到关闭信号后优雅退出，不留半投递状态（组合根 `signal.NotifyContext` 接线；测试在投递完成后取消并断言 10s 内干净退出。不留半投递由实现约束保障：认领事务跨 SMTP 发送持有，发送前取消即回滚回 pending；邮件上线后的状态提交用 `context.WithoutCancel` 完成，避免关机窗口造成重启后重复投递；未单独构造发送中途取消的测试用例）
- [x] 并发两个轮询者不重复投递同一行（`TestConcurrentPollersDoNotDuplicateDelivery`：两个 Worker 抢 8 行，每个收件人恰好 1 封）
- [x] 缺失任一 SMTP 变量时进程启动显式失败并说明缺哪个（`LoadSMTPConfig` 单测覆盖四个变量逐一缺失 + 非数字端口；二进制实跑验证 `missing required SMTP deployment variables: [SMTP_USER SMTP_PASSWORD]` exit 1）
- [x] identity Worker 与 GoTrue 的邮件落在同一个 Mailpit 收件箱（harness 单次运行中 `TestGoTrueSignupDeliversConfirmationEmailToMailpit` 与 outbox 测试对同一 `NEVIX_MAILPIT_URL` 断言均绿）
- [x] 测试只经事务写入缝与 Mailpit 断言，不触碰 Worker 私有实现、不 mock SMTP（测试仅使用导出的 `NewOutboxWorker`/`Run` 组合根表面、SQL 写入缝、Mailpit HTTP API 与行终态）

**实现注记：** go-mail 在配置了 auth 但服务器未通告 AUTH 时硬失败（v0.8.1 client.go:1493），而 Supabase 栈内 Mailpit 不通告 AUTH 且无配置开关；为保持生产切 Resend 零分支，Worker 构造时对端点做一次机会式探测（带 10s 超时的 EHLO → 如通告则 STARTTLS → 检查 AUTH），仅当服务器通告 AUTH 时启用 `SMTPAuthPlain`（拒绝在明文信道发送凭据，Resend API Key 不会泄露）——与 `TLSOpportunistic` 同一协商哲学，环境差异仍只是四个部署变量；端点不可达则构造失败、进程显式启动失败。

**合并后补记（2026-08-03）：** 真实 Resend 端到端冒烟通过——`SMTP_HOST=smtp.resend.com`、`SMTP_PORT=587`、`SMTP_USER=resend`、API Key 经 `server/.env.local` 注入（`make server` 自动加载）；sender 用 `onboarding@resend.dev` 发到账号注册邮箱。SQL 插入 Outbox 行后约 3 秒内行状态置 `delivered`，真实邮箱收件成功。这是 probe 的 STARTTLS + AUTH PLAIN 路径首个真实环境证据（Mailpit 不通告 AUTH，该路径此前无覆盖），印证「生产切 Resend 零分支」的设计承诺。

**遗留事项：**

- schema CHECK 约束预留了 `failed` 状态（spec 定案的终态失败契约），但本票无任何代码写入它；重试与终态失败属票 03
- Go 进程目前以 `DATABASE_URL` 直连（本地/CI 为 postgres owner）；ADR-0004 要求的专用最小权限数据库角色留待 identity-v1 schema 设计票一并处理（与本票 schema 的 expand 吸收同批）
- `internal/identity` 尚无 HTTP 路由故未建 `module.go`/`Register`；首个对外命令接口（票 04）落地时补齐
