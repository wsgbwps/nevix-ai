# 01 — 邮件测试 harness 与 GoTrue SMTP 冒烟

**What to build:** 一套可重复的邮件测试地基：版本钉定的临时 Supabase/PostgreSQL 栈（含 Mailpit）从空库启动、应用已提交 migration，Go 测试能通过 Mailpit HTTP API 读取收件箱；并以 GoTrue 注册验证邮件落入 Mailpit 的冒烟断言证明 GoTrue → captured mailbox 路径成立。开发者本地 `supabase start` 与 CI 使用同一套栈定义。落地 identity-v1 票 09 的 harness 研究结论。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 本地与 CI 均能从空库拉起版本钉定的 Supabase 栈，Mailpit 随栈可用（`scripts/test-mail-smoke.sh` 为本地与 CI 共用入口；CI 实跑见 PR #7）
- [x] Go 测试可通过 Mailpit HTTP API 查询收件箱内容（`server/internal/identity/mailpittest`）
- [x] 冒烟测试：触发 GoTrue 注册验证，断言邮件出现在 Mailpit（`server/internal/identity/gotrue_mail_smoke_test.go`，断言收件人与主题）
- [x] CI 中该冒烟稳定绿，不外发任何真实邮件（PR #7 实跑：Mail Smoke CI 4m03s 绿，日志确认 `PASS: TestGoTrueSignupDeliversConfirmationEmailToMailpit`，仅投递到栈内 Mailpit）
- [x] 栈与工具版本钉定并随仓库提交，两次运行结果一致（Supabase CLI 2.110.0 精确锁定于根 devDependencies；harness 脚本输出 `supabase services` 版本清单；实现者本地连续两次全新运行均绿，证据见 PR 描述）

实现备注：

- GitHub Actions 沿用仓库既有 `desktop-ci.yml` 的 tag 引用风格，未按票 09 研究建议改为 commit SHA 钉定；如需收紧，应对两个 workflow 一并处理，归独立任务。
