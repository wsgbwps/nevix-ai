# Context Map

## Contexts

- [Desktop](./apps/desktop/CONTEXT.md) — Electron 桌面客户端，含主进程、预加载层和渲染进程
- [Server](./server/CONTEXT.md) — Go 后端，API 服务与 Agent 编排

## Relationships

- **Desktop → Server**: Desktop 通过 HTTP 调用 Server API，契约定义在 `contracts/`（OpenAPI）
- **Desktop 内部**: 渲染进程通过 IPC Channel 与主进程通信，类型声明分散在各 domain 的 `shared/ipc/<domain>/types.ts`
