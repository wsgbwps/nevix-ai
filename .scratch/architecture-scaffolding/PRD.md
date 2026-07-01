# PRD: Architecture Scaffolding

Status: ready-for-agent

## Problem Statement

README.md 描述了完整的项目架构（Feature-Sliced + Vertical Slice + DDD），但当前代码库仍停留在 electron-vite 脚手架模板状态。目录结构、IPC 类型系统、preload 桥接层、渲染进程分层、Go 后端结构均未按架构设计搭建。团队无法在此基础上按 vertical-slice 方式并行开发 feature。

## Solution

按 README 架构规范搭建项目骨架，建立所有基础设施层（IPC 类型系统、typed preload、Feature-Sliced 目录、Go 分层结构），但不创建任何具体 feature 目录（如 video-generation、image-editing）——那些等真正开发时再创建。搭建完成后，三个测试 seam 全部通过：`pnpm typecheck`、`pnpm build`、`go build ./...`。

## User Stories

1. As a developer, I want `shared/ipc/channels.ts` to define the empty `IpcChannelMap` and `IpcEventMap` interfaces, so that future feature domains can independently extend them via declaration merging without editing any shared file.
2. As a developer, I want a `@ipc/channels` path alias configured in both tsconfig and electron-vite, so that declaration merging uses stable paths instead of fragile relative imports.
3. As a developer, I want `main/index.ts` to use `import.meta.glob('./ipc/*/index.ts', { eager: true })` for auto-discovering IPC handlers, so that adding a new domain only requires creating a directory.
4. As a developer, I want window creation logic extracted into `main/window/main-window.ts`, so that `main/index.ts` remains a pure orchestrator (app lifecycle + auto-registration only).
5. As a developer, I want the preload layer to expose `typedInvoke` and `typedOn` generic functions backed by `IpcChannelMap`/`IpcEventMap`, so that renderer-side IPC calls are type-safe and preload never needs per-domain edits.
6. As a developer, I want the renderer to follow Feature-Sliced layout with `app/` (globals.css, App.tsx, providers.tsx), `features/`, `components/ui/`, `lib/`, `hooks/`, and `assets/` directories, so that feature code has a clear home from day one.
7. As a developer, I want `globals.css` to live at `app/globals.css` (the canonical location per README), so that the single styling entry point is unambiguous.
8. As a developer, I want `main.tsx` to import from the new `app/` path and render through `providers.tsx`, so that global providers (QueryClient, future ThemeProvider) have a single composition point.
9. As a developer, I want the Go server restructured with `cmd/server/main.go` as the entry point, so that it follows standard Go project layout and `main.go` at server root is eliminated.
10. As a developer, I want `server/pkg/event/` with `types.go` (event type definitions) and `bus.go` (event bus interface), so that inter-module communication infrastructure exists before any module needs it.
11. As a developer, I want `server/pkg/middleware/`, `server/pkg/auth/`, and `server/pkg/database/` directories with placeholder files, so that the shared infrastructure layout is visible and discoverable.
12. As a developer, I want `server/internal/` to exist as the home for business modules, so that the first feature developer doesn't have to decide where modules live.
13. As a developer, I want `tsconfig.web.json` include globs to cover `src/shared/**/*.ts`, so that tsc automatically merges all IPC type augmentations.
14. As a developer, I want `tsconfig.node.json` include globs to cover `src/shared/**/*.ts`, so that main process code can also reference the IPC type system.
15. As a developer, I want `app.setAppUserModelId` to use `'com.nevix.ai'` (not `'com.electron'`), so that the app identity matches the production App ID from README.
16. As a developer, I want `main/ipc/` directory to exist (empty, ready for domain subdirectories), so that the auto-registration glob has a target and the first handler author just creates a subdirectory.
17. As a developer, I want `pnpm typecheck`, `pnpm build`, and `cd server && go build ./cmd/server` to pass after all changes, so that CI stays green and the architecture is provably sound.
18. As a developer, I want the Makefile `server` target updated to `cd server && go run ./cmd/server`, so that it matches the new Go entry point.

## Implementation Decisions

- **IPC 类型基座**：`src/shared/ipc/channels.ts` 导出两个空 interface（`IpcChannelMap`、`IpcEventMap`）。这是唯一的共享编辑点，且初始化后永不需要再编辑。path alias `@ipc/channels` 指向此文件。
- **Declaration merging 路径**：各 domain 未来在 `src/shared/ipc/<domain>/types.ts` 中通过 `declare module '@ipc/channels'` 扩展。当前不创建任何 domain 子目录。
- **tsconfig include 扩展**：`tsconfig.web.json` 和 `tsconfig.node.json` 的 include 数组中加入 `src/shared/**/*.ts`，使 tsc 自动聚合所有 augmentation。
- **Vite alias 扩展**：`electron.vite.config.ts` 的 main 配置中加入 `@ipc/channels` alias 指向 `src/shared/ipc/channels.ts`；renderer 配置中同样添加（供 renderer import 具名类型用）。
- **Preload 改造**：用 `ipcRenderer.invoke` 实现 `typedInvoke<K extends keyof IpcChannelMap>`，用 `ipcRenderer.on` 实现 `typedOn<K extends keyof IpcEventMap>`。通过 `contextBridge.exposeInMainWorld('api', { invoke: typedInvoke, on: typedOn })` 暴露。
- **Window 提取**：`main/window/main-window.ts` 导出 `createWindow()` 函数，`main/index.ts` import 并调用。
- **IPC 自注册**：`main/index.ts` 中 `import.meta.glob('./ipc/*/index.ts', { eager: true })` 获取所有 domain 模块，遍历调用每个模块的 `register()` 函数。当前 `main/ipc/` 为空目录（放 `.gitkeep`），glob 匹配零个文件不报错。
- **Renderer 目录重组**：将 `App.tsx` 移入 `app/App.tsx`，`main.css` 移入 `app/globals.css`，新建 `app/providers.tsx`（空 providers shell）。`main.tsx` 更新 import 路径。
- **Feature-Sliced 占位**：创建 `features/`、`hooks/` 目录（`.gitkeep`）。`components/ui/` 和 `lib/` 已存在，保持原位。`assets/` 保留，内容清空为 `.gitkeep`（样式文件已移入 `app/`）。
- **Go 结构重组**：`server/main.go` → `server/cmd/server/main.go`。创建 `server/internal/`（`.gitkeep`）、`server/pkg/event/`（`types.go` + `bus.go`）、`server/pkg/middleware/`（`.gitkeep`）、`server/pkg/auth/`（`.gitkeep`）、`server/pkg/database/`（`.gitkeep`）。
- **Go event bus 接口**：`pkg/event/bus.go` 定义 `Bus` interface（`Publish`、`Subscribe`）和 `Event` 基础 struct。`pkg/event/types.go` 为空文件，预留事件类型定义。这是最小的跨模块通信基础设施。
- **App ID 修正**：`main/index.ts` 中 `electronApp.setAppUserModelId('com.nevix.ai')`。

## Testing Decisions

- 使用三个已有 seam 验证架构正确性，不引入新的测试框架或工具：
  1. **`pnpm typecheck`**（`tsc --noEmit`）— 验证 path alias 解析、declaration merging 基座编译、IPC 类型导出/导入链完整
  2. **`pnpm build`**（`electron-vite build`）— 验证 Vite alias 解析、`import.meta.glob` 正确执行（即使匹配零文件）、所有 import 路径在构建后可达
  3. **`go build ./cmd/server`** — 验证 Go module 结构编译通过，pkg 和 internal 的 import 路径正确
- 不编写单元测试——此 PRD 是纯结构搭建，没有业务逻辑可测
- 后续 feature PRD 应在各自 seam 中测试具体的 IPC handler 注册和类型安全性

## Out of Scope

- 创建具体的 feature 目录（video-generation、image-editing、project-management）——等各 feature PRD 启动时创建
- TanStack Router 文件路由配置——等有实际页面时添加
- TanStack Query / Zustand 安装和配置——等有数据获取需求时添加
- electron-updater / auto-updater 配置——独立 feature
- Go chi router 引入——等第一个 HTTP endpoint 需求时添加
- CI/CD workflow 调整——当前 workflow 已能 build，结构调整不影响
- `preload/index.d.ts` 更新——需配合 typedInvoke/typedOn 实现一起修改

## Further Notes

- `preload/index.d.ts` 需要与 preload 实现同步更新，声明 `window.api` 的类型包含 `invoke` 和 `on` 方法。这是 renderer 能获得类型提示的关键。
- `vite.config.ts`（根目录 stub）无需修改，它仅供 shadcn CLI 使用，不参与实际构建。
- `import.meta.glob` 在匹配零文件时返回空对象，不报错，因此 `main/ipc/` 为空目录不影响构建。
- Go 的 `internal/` 目录仅需 `.gitkeep` 占位——Go 编译器不会因空目录报错，只有 git 需要它来跟踪空目录。
