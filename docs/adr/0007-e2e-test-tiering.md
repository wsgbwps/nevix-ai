# Desktop 测试分层：CI 跑 Native Smoke，本地 Mac 跑 Full E2E

2026-09-04 起，Desktop 交付使用四层验证：Linux 基础检查、PR 的 source Native
Smoke、本地 Mac Full E2E，以及发布候选的 packaged Native Smoke。本决策取代此前
在 Ubuntu/Xvfb 中运行 Desktop Smoke/Full E2E 的 CI 分层。

## Decision

- Linux CI 只运行 Desktop lint、架构检查、typecheck、unit、component 与 build；Server
  测试仍由 Server CI 拥有。Linux 不再运行 Electron E2E，也不是 Desktop 打包目标。
- 所有改变 Desktop 运行时的 PR 在 `windows-latest` 运行 source Native Smoke。触及
  `src/main/`、`src/preload/`、`src/shared/`、`build/`、Electron/打包配置、依赖清单或
  Native Smoke 自身时，同时在 `macos-latest` 运行。Desktop 文档、`test-results/`、
  unit 与 component 测试不启动 Native Smoke。
- `@native-smoke` 套件不启动 Go、PostgreSQL、Docker、TLS 或外部网络。它验证 Renderer
  首次提交、原生编辑菜单与剪贴板快捷键、窗口状态跨重启恢复，并通过真实
  Keychain/DPAPI 写入 Session 与 Remembered Email：文件不得含明文，重启后必须可读，
  clear 后必须消失。目标平台的安全后端不可用时直接失败，不允许 skip 或明文降级。
- `make test-e2e` / `pnpm test:e2e` 保留为本地 Mac Full E2E，继续使用现有 Docker
  harness。认证、Session、连接/TLS、安全边界改动与发布前检查必须运行并在 PR
  或发布记录中注明结果。Server 与 `contracts/` 变更的自动门禁只触发 Server CI，跨层
  验收由这一本地 Full E2E 承担。
- `v*` tag 与 Desktop workflow 手动触发都在 macOS/Windows 并行打包，然后直接启动
  `.app` 或 `win-unpacked/Nevix AI.exe` 运行 packaged Native Smoke。不测试 DMG/NSIS
  安装与卸载，也不在此流程发布 artifact。
- Native source job 预算 10 分钟，发布打包 job 预算 30 分钟；沿用 Playwright 在 CI
  中的一次 retry。失败截图与 Electron 日志保留 7 天。

`CI gate` 仍是唯一聚合门禁：路径分类器输出 `windows_native` / `macos_native`
布尔值给现有 Desktop reusable workflow，任一 Native job 失败都会使 Desktop 调用和最终
gate 失败。并发取消、PR 树复用与合并后 tree-SHA 去重保持不变。不再使用
`skip-e2e` / `full-e2e` 标签或独立 Desktop E2E workflow。

## Considered Options

- **继续在 Linux 跑 Electron E2E**：Xvfb 不能代表真实 Keychain/DPAPI，`basic_text` 也不是
  可接受的加密后端；它还把 Go/PostgreSQL/Docker harness 成本加到日常 PR。
- **所有 Desktop 改动同时跑 macOS 和 Windows**：Renderer-only 改动无需为 macOS 原生差异
  支付额外成本；Windows 作为日常补盲，macOS 保留给原生敏感路径。
- **nightly Full E2E**：单人仓库无人值守夜间失败；高风险改动与发布前的明确本地
  Mac 记录是更直接的验收点。

## Consequences

- CI 快速反馈集中在真实桌面平台和无后端原生能力；网络认证与跨层契约不再由
  GitHub-hosted Electron E2E 自动覆盖。
- macOS 是本地 Full E2E 与发布前验收平台；Windows 是日常 CI 的必跑原生补盲平台。
- 不新增 nightly、Linux Desktop 发布、签名/notarization、安装器流程或 artifact 发布。
- Linux `basic_text` 的拒绝逻辑与回归测试保留；删除 Linux Desktop 发布入口不降低
  安全防御。
