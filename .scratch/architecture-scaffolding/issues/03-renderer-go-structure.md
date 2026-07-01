# 渲染进程 + Go 后端目录结构重组

Status: done

## Parent

[Architecture Scaffolding PRD](../PRD.md)

## What to build

**渲染进程 Feature-Sliced 重组：**

将渲染进程目录调整为 Feature-Sliced Design 布局。将 `App.tsx` 移入 `app/App.tsx`，将 `assets/main.css` 移入 `app/globals.css`（README 规定的全局样式唯一归属地）。新建 `app/providers.tsx` 作为全局 providers 组合点（当前为空 shell，导出包裹 `children` 的组件）。更新 `main.tsx` 的 import 路径指向新位置。

创建 `features/`、`hooks/` 占位目录（`.gitkeep`）。`components/ui/` 和 `lib/` 已存在，保持原位。`assets/` 目录保留（放 `.gitkeep`），其中的样式文件已移走。

**Go 后端标准结构重组：**

将 `server/main.go` 移动到 `server/cmd/server/main.go`，遵循标准 Go 项目布局。创建 `server/internal/` 目录（`.gitkeep`）作为未来业务模块的家。

创建 `server/pkg/event/` 目录，包含：`bus.go`（定义 `Bus` interface 和 `Event` 基础结构体）和 `types.go`（预留事件类型定义的空文件）。这是跨模块通信的最小基础设施。

创建 `server/pkg/middleware/`、`server/pkg/auth/`、`server/pkg/database/` 占位目录（`.gitkeep`）。

更新 Makefile 的 `server` target 为 `cd server && go run ./cmd/server`。

## Acceptance criteria

- [x] `src/renderer/src/app/App.tsx` 存在，内容从原 `App.tsx` 迁移
- [x] `src/renderer/src/app/globals.css` 存在，内容从原 `assets/main.css` 迁移
- [x] `src/renderer/src/app/providers.tsx` 存在，导出包裹 children 的 Providers 组件
- [x] `src/renderer/src/main.tsx` 的 import 路径指向 `app/` 下的新位置
- [x] `src/renderer/src/features/` 目录存在（含 `.gitkeep`）
- [x] `src/renderer/src/hooks/` 目录存在（含 `.gitkeep`）
- [x] `src/renderer/src/assets/` 目录保留（含 `.gitkeep`，样式文件已移走）
- [x] 原 `src/renderer/src/App.tsx` 和 `src/renderer/src/assets/main.css` 已删除
- [x] `server/cmd/server/main.go` 存在，内容从原 `server/main.go` 迁移
- [x] 原 `server/main.go` 已删除
- [x] `server/internal/` 目录存在（含 `.gitkeep`）
- [x] `server/pkg/event/bus.go` 存在，定义 `Bus` interface
- [x] `server/pkg/event/types.go` 存在
- [x] `server/pkg/middleware/`、`server/pkg/auth/`、`server/pkg/database/` 目录存在（含 `.gitkeep`）
- [x] Makefile `server` target 使用 `cd server && go run ./cmd/server`
- [x] `pnpm typecheck` 通过
- [x] `pnpm build` 通过
- [x] `cd server && go build ./cmd/server` 通过

## Blocked by

None - can start immediately
