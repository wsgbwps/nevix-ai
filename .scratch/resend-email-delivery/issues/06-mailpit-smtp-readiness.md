# 06 — Mailpit SMTP readiness 必须与 HTTP readiness 一起验证

**What to build:** 让本地/CI Mail Smoke harness 在运行 Identity Outbox 集成测试前，以及测试通过 Docker 重启 Mailpit 后，同时确认 Mailpit HTTP API 与宿主 SMTP 映射 `127.0.0.1:54325` 可用。HTTP `/readyz` 成功不能单独代表 SMTP 已可投递；任一端点超时或不可达时，入口必须具名 fail-closed。

**Status:** resolved — [PR #38](https://github.com/wsgbwps/nevix-ai/pull/38) 已于 2026-08-11 squash merge（`6e50029`）

**Primary Domain:** 开发与 CI 的 Supabase 集成 harness；Identity Outbox Worker 的 Mailpit 测试支持。

**Narrow owners:** `scripts/test-mail-smoke.sh` 的初始 readiness 检查，以及 `server/internal/identity/integrationtest/` 中 Mailpit stop/start 后的恢复等待。不得改变生产 SMTP 配置、Outbox 业务规则、数据库 schema/migrations 或 ADR-0004 trusted-execution seam。

## Reproduction

在干净、本地拥有的 `nevix-ai` Supabase 栈中执行 `supabase start`、`supabase db reset --local` 后，现有脚本的 `http://127.0.0.1:54324/readyz` 通过，但对 `127.0.0.1:54325` 的 TCP 连接仍被拒绝。随后运行 `go test -C server -race -count=1 -v -run '^TestIssuedCodeEmailArrivesInMailpit$' ./internal/identity/integrationtest` 无法满足 Outbox Worker 的 SMTP 前置条件。

同一现象在两次完整 `./scripts/test-mail-smoke.sh` 中复现，且两次都发生在 migration replay、lint、advisor、migration history 和 declarative drift gates 已通过之后。跳过新增数据库 gates 的 targeted baseline 仍复现，证明不是数据库契约 gate 引入的回归。

## Acceptance

- [x] 初始 Mail Smoke readiness 在有限超时内同时验证 Mailpit HTTP API 与宿主 SMTP 端口，并在失败时说明缺失的 endpoint。
- [x] Mailpit 被测试 stop/start 后，恢复等待同样验证 HTTP 与 SMTP；不能仅因 HTTP API 可访问就继续投递断言。
- [x] 现有 stop/start 故障注入仍保留真实 SMTP 不可用语义，不引入 mock 或跳过测试。
- [x] 干净的隔离 CI 本地 Supabase 栈中，完整 `./scripts/test-mail-smoke.sh` 连续通过两次；PR CI 通过 Mail Smoke workflow。

## Comments

- 2026-08-11: 从 `database-contract-gates-not-mechanical` finding 的验收中拆分。该 finding 的五个数据库 gates 已独立通过，声明式 schema 偏差能使 drift gate 返回非零；SMTP readiness 属既有 Mailpit 生命周期前置条件，需独立修复和验证。
- 2026-08-11: 实现已提交至 [PR #38](https://github.com/wsgbwps/nevix-ai/pull/38)。聚焦 shell/Go 验证与独立 diff review 通过；本机完整 smoke 受另一 worktree 中持续运行的 `make server` 干扰，该进程连接同一 canonical 本地数据库并以生产退避抢占测试 Outbox 行，故未停止他人进程，等待 PR 的隔离 CI runner 提供连续 clean-stack Mail Smoke 信号。
- 2026-08-11: [PR #38](https://github.com/wsgbwps/nevix-ai/pull/38) 已 squash merge 为 `6e50029`。全部 PR checks 成功；Mail Smoke CI 在两个独立的 runner attempt 中均完成完整 smoke（5m11s、5m04s）。
