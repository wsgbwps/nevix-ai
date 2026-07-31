# 01 — 邮件测试 harness 与 GoTrue SMTP 冒烟

**What to build:** 一套可重复的邮件测试地基：版本钉定的临时 Supabase/PostgreSQL 栈（含 Mailpit）从空库启动、应用已提交 migration，Go 测试能通过 Mailpit HTTP API 读取收件箱；并以 GoTrue 注册验证邮件落入 Mailpit 的冒烟断言证明 GoTrue → captured mailbox 路径成立。开发者本地 `supabase start` 与 CI 使用同一套栈定义。落地 identity-v1 票 09 的 harness 研究结论。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 本地与 CI 均能从空库拉起版本钉定的 Supabase 栈，Mailpit 随栈可用
- [ ] Go 测试可通过 Mailpit HTTP API 查询收件箱内容
- [ ] 冒烟测试：触发 GoTrue 注册验证，断言邮件出现在 Mailpit
- [ ] CI 中该冒烟稳定绿，不外发任何真实邮件
- [ ] 栈与工具版本钉定并随仓库提交，两次运行结果一致
