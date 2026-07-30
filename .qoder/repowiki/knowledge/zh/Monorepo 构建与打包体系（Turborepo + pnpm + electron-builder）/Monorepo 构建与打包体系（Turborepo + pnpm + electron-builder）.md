---
kind: build_system
name: Monorepo 构建与打包体系（Turborepo + pnpm + electron-builder）
category: build_system
scope:
    - '**'
source_files:
    - Makefile
    - package.json
    - turbo.json
    - pnpm-workspace.yaml
    - go.work
    - apps/desktop/package.json
    - apps/desktop/electron-builder.yml
    - .github/workflows/desktop-ci.yml
    - server/go.mod
---

本仓库采用 **Turborepo + pnpm Workspaces** 作为多语言 Monorepo 的构建编排核心，将 Electron 桌面应用（apps/desktop）与 Go 后端服务（server）统一纳入同一工作区管理。构建流程围绕以下层次展开：

**1. 顶层入口与任务编排**
- `Makefile` 提供 `dev`、`build`、`lint`、`server`、`setup` 五个快捷目标，内部均委托给 `pnpm` 或 `go run`。
- 根 `package.json` 通过 `turbo run build/dev/lint` 调用 Turborepo 任务，`prepare` 钩子初始化 Husky。
- `turbo.json` 定义任务依赖图：`build` 依赖上游 `^build`，输出目录为 `dist/**` 和 `out/**`；`dev` 禁用缓存并持久运行；`lint` 依赖上游 `^lint`。

**2. 包管理与工作区**
- `pnpm-workspace.yaml` 声明 `apps/*` 为工作区包，并通过 `allowBuilds` 显式允许 electron、electron-winstaller、esbuild 等原生构建。
- `pnpm-lock.yaml` 锁定依赖版本，CI 使用 `--frozen-lockfile` 保证可重现安装。
- `go.work` 声明 Go 1.26.3 并使用 `./server` 模块，使 Go 代码也参与 monorepo 管理。

**3. Electron 应用构建与打包**
- `apps/desktop/package.json` 中 `build` 脚本先执行 TypeScript 类型检查，再调用 `electron-vite build` 编译。
- `electron-builder.yml` 配置跨平台打包：Windows 生成 NSIS 安装包（支持 en_US/zh_CN），macOS 生成 dmg（含相机/麦克风权限声明），Linux 同时产出 AppImage、snap、deb。
- 产物命名遵循 `${version}` 占位符，如 `Nevix-AI-${version}-setup.${ext}`。
- 本地化资源通过 `extraResources` 从 `build/locales` 注入，`asarUnpack` 保留 `resources/**` 不被压缩。
- 自动更新指向 generic provider（`https://example.com/auto-updates`）。

**4. CI/CD 流水线（GitHub Actions）**
- `.github/workflows/desktop-ci.yml` 在 push main、tag v* 及 PR 到 main 时触发。
- `quality` job：Ubuntu 环境安装 xvfb，执行 lint 与 `test:auth`（Playwright E2E）。
- `package` job：仅在 tag 发布时触发，矩阵并行打包 macOS 与 Windows，注入 Supabase 环境变量。

**5. Go 后端构建**
- `server/go.mod` 定义模块路径 `github.com/nevix-ai/server`，Go 版本 1.26.3。
- `Makefile server` 目标直接 `cd server && go run ./cmd/server` 启动，未单独定义 build 目标。

**约定与约束**
- 所有构建任务必须通过 `pnpm turbo` 统一入口，禁止绕过 Turborepo 直接调用子任务。
- 依赖安装必须使用 `pnpm install --frozen-lockfile`，确保 CI 与本地一致。
- Electron 打包产物仅包含 `dist/` 与 `out/` 目录，源码与配置文件被排除。
- Go 代码通过 `go.work` 统一管理，不独立使用 `go mod` 工作区。
- 预提交钩子由 Husky + lint-staged 驱动：TS/JS 文件走 Prettier，Go 文件走 `goimports -w`。