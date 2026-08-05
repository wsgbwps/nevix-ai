# 01 CI 分层 E2E 门禁

Status: done — PR #23 经 CI 把关合并入 main（9834e29）

新建 `desktop-e2e-ci.yml`：`e2e-smoke` job 仅在 PR 触发（`--grep @smoke`，一次 test 模式构
建，预算 ≤10 分钟），`e2e-full` job 仅在 main push 与 workflow_dispatch 触发（配置失败构
建 + 全部 spec）。runner 钉 ubuntu-24.04，Electron 经 xvfb 运行，job 注入
`NEVIX_TEST_FORCE_BASIC_TEXT_STORAGE=1` 避免 Linux 上 Session 持久化测试静默 skip。

配套改动：

- 首批 `@smoke` 成员：login-boundary 的未登录边界与已验证登录两个用例、
  signup-verification 的完整 OTP 注册用例、app-shell 的已登录呈现用例。
- `readAuthHarnessConfig` / `readMailpitHarnessConfig` 在 CI 环境（`CI` 变量存在）缺配时
  直接抛错，禁止"绿而漏测"。
- `scripts/run-auth-e2e.sh` 更名 `run-e2e.sh` 并支持 `full|smoke` 模式；package.json 的
  `test:auth` 正名为 `test:e2e` / `test:e2e:smoke`。

验收：本 PR 上 `e2e-smoke` 绿；合并后 main push 触发 `e2e-full` 绿。
