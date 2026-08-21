# ADR-0001: IPC 自注册与分散类型声明

## 状态

已接受 — 2026-07-01

TypeScript runtime registration 的物理路径与 glob 于 2026-07-30 被 [Desktop ADR-0003](../../apps/desktop/docs/adr/0003-main-domain-first-ipc-adapters.md) 部分取代。下文第 2 项及效果表中的 `main/ipc/<domain>/` 路径保留为原始决策记录；分散类型声明、declaration merging、generic preload、自注册原则和 Go 显式注册决定继续有效。

## 背景

项目采用 3 人团队 vertical-slice 开发，每人负责一个 feature domain（初始规划为 video-generation、image-editing、project-management）。AI 业务 owner 示例后来由 [ADR-0012](0012-unified-ai-creation-owner.md) 统一为 `creation`；本 ADR 保留其原始背景，不再把初始名称视为当前 owner。初始架构设计中有三个共享文件会被所有开发者频繁编辑：

- `ipc/types.ts` — 集中定义所有 IPC channel 的请求/响应类型
- `ipc/register.ts` — 手工 import 并注册所有 domain 的 handler
- `cmd/server/main.go` — 手工注册所有 module 的路由和事件订阅

这与"物理隔离、互不冲突"的核心目标直接矛盾。

## 决策

### TypeScript 侧

1. **类型分散声明，tsconfig include 聚合。** `src/shared/ipc/channels.ts` 定义空的 `IpcChannelMap` 和 `IpcEventMap` 两个 interface。各 domain 在自己的 `shared/ipc/<domain>/types.ts` 里通过 `declare module '@ipc/channels'` 扩展它们。`tsconfig` 的 include glob 覆盖 `shared/**/*.ts`，tsc 自动合并所有 augmentation——无需 barrel 文件。已验证在 `--isolatedModules` 下可用。

2. **运行时自注册。** `main/index.ts` 用 `import.meta.glob('./ipc/*/index.ts', { eager: true })` 在构建时自动发现并注册所有 domain 的 handler。electron-vite 对 main 进程使用 Vite (Rollup) 构建，支持 `import.meta.glob`。

3. **Preload 通用化。** preload 不做 per-domain 代码，只暴露 `typedInvoke` 和 `typedOn` 两个泛型函数，类型从 `IpcChannelMap` / `IpcEventMap` 推导。加新 domain 不需要编辑 preload。

4. **类型粒度。** 每个 domain 的 `types.ts` 独立导出具名的 request/response 类型（如 `GenerateVideoReq`），再在 `declare module` 中引用。renderer 可直接 import 具名类型，而不必写 `IpcChannelMap['video:generate']['request']`。

5. **declare module 用 path alias。** `@ipc/channels` 而非相对路径，避免目录层级变化导致的路径断裂。

### Go 侧

6. **显式注册，不用 `init()` + blank import。** 每个 module 导出 `Register(r chi.Router, bus event.Bus)`，`main.go` 逐个调用。路由和事件订阅在同一个函数中完成。`main.go` 是会被编辑的，但每次只增加一行，冲突概率极低。保留了所有路由的可见性。

## 效果

| 操作 | 需要编辑的文件 |
|------|---------------|
| 给已有 domain 加 handler | `shared/ipc/<domain>/types.ts` + `main/ipc/<domain>/index.ts`（均为自己目录） |
| 新增 domain（TS） | 创建 `shared/ipc/<domain>/types.ts` + `main/ipc/<domain>/index.ts`（自动发现） |
| 新增 domain（Go） | 创建 `internal/<module>/` + `main.go` 加一行 `Register` 调用 |
| 编辑 preload | 永远不需要 |

## 被拒绝的替代方案

- **集中 `ipc/types.ts`**：3 人同时编辑，冲突频繁。
- **`_augmentations.ts` barrel 文件**：实测 tsconfig include 已足够，barrel 是不必要的额外共享编辑点。
- **Go `init()` + blank import**：隐藏了依赖关系和注册顺序，对 3 module 规模的项目不值得。
