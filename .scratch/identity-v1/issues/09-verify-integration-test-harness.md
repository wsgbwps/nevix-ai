# Verify the Integration Test Harness

Type: research
Status: resolved
Blocked by: none
Research branch: `research/identity-integration-harness`

## Question

基于当前仓库和官方工具，怎样以版本固定、可重复的临时 Supabase/PostgreSQL、邮件捕获器、Go tests 与 Electron Playwright 构成 CI harness，并真实验证 migrations、RLS、JWKS、Outbox、CSP 和 Session 持久化？

## Answer

Identity V1 的最小可行集成 harness 是一个固定版本、一次性销毁的 Linux CI job：

- Supabase CLI local stack 提供 PostgreSQL、Auth、Data API、Realtime 与 Mailpit；从空库重放 migrations。
- 数据库 gate 包含 lint、advisors、pgTAP，以及使用真实 Auth token 的 Data API/RLS 黑盒测试。
- Go 使用独立最小权限测试角色，验证真实 JWKS、可信命令、事务与 Outbox 并运行 race detector。
- 构建后的 Electron 通过 Xvfb + Playwright 连接同一环境，验证 sandbox、CSP HTTP/WS allowlist、Session 重启/退出/损坏与 Linux `basic_text` 拒绝持久化。
- Ubuntu lane 不能证明 macOS Keychain、Windows DPAPI、真实 Linux Secret Service、生产 TLS/WSS、托管 JWKS cache 或真实邮件供应商；这些需要独立 staging/native smoke evidence。
- 实施时固定 CLI、Node、Go、Electron/Playwright 与 runner 版本，单命令拥有完整生命周期，并保证失败后清理容器、volume 与临时签名私钥。

完整引用研究资产位于 `research/identity-integration-harness` 分支，commit `53c9045eb6fa49e735aa8274c9879292e192e72d` 的 `.scratch/identity-v1/research/integration-test-harness.md`。
