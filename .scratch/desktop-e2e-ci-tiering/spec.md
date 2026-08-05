# Desktop E2E CI 分层与提速

## 背景

Desktop 的 Electron E2E 此前只能本地全量串行执行（4 次构建 + 全部 spec），CI 完全不跑 E2E：
认证主链路没有自动门禁，本地开发每次全量又成为瓶颈。经 grilling 会话达成切片共识，决策记
录在 [ADR-0007](../../docs/adr/0007-e2e-test-tiering.md)。

## 切片

- **切片 A — CI 分层门禁**（issues/01）：PR 跑 Smoke Suite（`@smoke` tag，≤10 分钟），main
  push 跑 Full E2E Suite；CI 中 Auth Harness 缺失即 fail；脚本正名 `test:e2e` /
  `test:e2e:smoke`。
- **切片 B — 并行化**（issues/02）：文件级并行 `workers=2`，登录态复用挂起待实测。
- **切片 C — 组件测试下推**：暂缓。settings/i18n 等纯 UI 用例是否下推到 component test，
  待 A、B 落地并实测剩余痛点后再立项。
