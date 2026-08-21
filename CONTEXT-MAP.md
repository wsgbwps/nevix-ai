# Context Map

## Contexts

- [Desktop](./apps/desktop/CONTEXT.md) — Electron 桌面客户端，含主进程、预加载层和渲染进程
- [Server](./server/CONTEXT.md) — Go 后端，API 服务与 Agent 编排
- [仓库级术语](./CONTEXT.md) — 跨 context 的交付/CI 词汇（如 gate 强制）

## Relationships

- **Desktop → Supabase**: Desktop 使用 publishable/anon key 和用户 JWT 直接调用受 RLS 或 Storage Policy 保护的 Auth、普通 CRUD、Storage 和 Realtime
- **Desktop → Server**: 只有必须进入可信执行 seam 的命令才通过 HTTP 调用 Server，契约定义在 `contracts/`（OpenAPI）
- **Desktop AI Creation → Server AI Creation Module**: 两侧与可信 OpenAPI seam 共享 canonical owner `creation`；图片/视频、页面与供应商 adapter 不产生并行业务 owner
- **Server → PostgreSQL**: Server 的事务和后台任务使用专用最小权限角色直连数据库
- **Server → AI 供应商**: 复杂 module 在 infrastructure 中通过 adapter 接入供应商；Webhook 通过 Server 的可信 interface 回传状态
- **Desktop 内部**: 渲染进程通过 IPC Channel 与主进程通信，类型声明分散在各 domain 的 `shared/ipc/<domain>/types.ts`

完整职责和非目标见 [ADR-0004](./docs/adr/0004-supabase-go-trusted-execution-seam.md)。Supabase、PostgreSQL 和 AI 供应商是外部基础设施，不是新的 bounded context。
