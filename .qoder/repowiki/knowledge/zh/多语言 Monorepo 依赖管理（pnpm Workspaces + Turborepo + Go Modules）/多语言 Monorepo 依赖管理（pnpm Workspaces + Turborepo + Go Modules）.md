---
kind: dependency_management
name: 多语言 Monorepo 依赖管理（pnpm Workspaces + Turborepo + Go Modules）
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - pnpm-workspace.yaml
    - pnpm-lock.yaml
    - apps/desktop/package.json
    - server/go.mod
    - go.work
    - turbo.json
---

本仓库采用分层式多包依赖管理策略：前端/桌面端使用 pnpm Workspaces + Turborepo，Go 后端使用 go.work 多模块编排，两者通过独立 lockfile 与版本约束保持可重复构建。

**1. 使用的系统与工具**
- **pnpm Workspaces**：根目录 `package.json` 声明 `packageManager: "pnpm@11.0.9"`，`pnpm-workspace.yaml` 将 `apps/*` 纳入工作区，并通过 `allowBuilds` 显式允许 electron、electron-winstaller、esbuild 等原生构建。
- **Turborepo**：根级 `turbo.json` 定义 `build`、`dev`、`lint` 任务及其依赖顺序与缓存策略，统一驱动各子包的脚本执行。
- **Go Modules + go.work**：`server/go.mod` 声明 module 路径与 `go 1.26.3`，根级 `go.work` 通过 `use ./server` 将 Go 子模块纳入工作区。
- **Husky + lint-staged**：根 `package.json` 中配置 pre-commit 钩子，对 TS/TSX/JS/JSON/CSS/YAML 运行 Prettier，对 Go 文件运行 `goimports -w`。

**2. 关键文件与位置**
- `package.json`（根）：Monorepo 入口脚本、全局 devDependencies（husky、lint-staged、prettier、turbo）、`packageManager` 锁定 pnpm 版本。
- `pnpm-workspace.yaml`：工作区包路径与允许的原生构建器白名单。
- `pnpm-lock.yaml`：完整依赖解析快照（lockfileVersion 9.0），包含 apps/desktop 下所有依赖的精确版本与 integrity hash。
- `apps/desktop/package.json`：Electron 应用依赖声明，含运行时依赖（@supabase/supabase-js、i18next、radix-ui 等）与开发依赖（electron、electron-builder、vite、typescript 等），并通过 `pnpm.onlyBuiltDependencies` 仅对 electron/esbuild 执行原生构建。
- `server/go.mod`：Go 模块声明，当前仅声明模块名与 Go 版本，无第三方依赖引入。
- `go.work`：Go 工作区，指向 `./server`。
- `turbo.json`：任务编排与缓存配置。

**3. 架构与约定**
- **单锁文件策略**：pnpm 在根目录生成单一 `pnpm-lock.yaml`，所有 workspace 包共享同一份依赖解析结果，避免版本漂移。
- **严格版本约束**：部分关键依赖使用固定版本（如 `@supabase/supabase-js: 2.111.0`、`supabase: 2.110.0`、`electron: ^39.2.6`），其余使用 caret 范围（`^`）以平衡稳定性与更新灵活性。
- **原生构建最小化**：通过 `pnpm.onlyBuiltDependencies` 和 `pnpm-workspace.yaml` 的 `allowBuilds` 白名单，仅允许必要的原生模块参与构建，加速安装并减少 CI 开销。
- **Go 模块隔离**：Go 代码独立于 Node 生态，通过 `go.work` 聚合，未启用 vendor 模式，依赖由 `go mod tidy` 管理（当前无外部依赖）。
- **构建产物缓存**：Turborepo 将 `dist/**` 与 `out/**` 标记为 build 输出，支持跨任务增量缓存。

**4. 约定与约束**
- **包管理器锁定**：根 `package.json` 的 `packageManager` 字段强制使用 pnpm@11.0.9，确保团队环境一致。
- **工作区包路径约定**：所有前端/桌面应用必须放在 `apps/` 目录下才能被 pnpm 识别为 workspace 包。
- **原生构建白名单**：只有 `electron`、`electron-winstaller`、`esbuild` 被允许执行原生构建，其他包若包含 native addon 将被跳过安装。
- **Git Hooks 强制格式化**：通过 husky + lint-staged 在提交前自动格式化代码，Go 文件使用 `goimports` 整理 import。
- **Go 版本锁定**：`go.mod` 与 `go.work` 均声明 `go 1.26.3`，确保编译一致性。
- **无私有注册表配置**：未发现 `.npmrc`、`.pnpmrc`、`GOPRIVATE` 或自定义 registry 配置，依赖全部来自公共 npm registry 与 Go proxy。
- **无 vendoring**：Go 模块未启用 `vendor` 目录，Node 依赖通过 pnpm 的符号链接策略而非复制安装。