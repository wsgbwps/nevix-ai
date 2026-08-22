# Context Map

## Contexts

- [Desktop](./apps/desktop/CONTEXT.md) — Electron 桌面客户端，含主进程、预加载层和渲染进程
- [Server](./server/CONTEXT.md) — Go 后端，API 服务与 Agent 编排
- [仓库级术语](./CONTEXT.md) — 跨 context 的交付/CI 词汇（如 gate 强制、License）

## Relationships

- **Desktop → Server**: Desktop 的全部数据访问——认证、业务 CRUD、文件与推送——经 Go HTTP API（Bearer session token，SSE 为 fetch-stream），契约定义在 `contracts/`（OpenAPI）；Desktop 不持有数据库凭据，server URL 为运行时配置，自签证书走 TOFU 指纹钉扎
- **Desktop AI Creation → Server AI Creation Module**: 两侧与可信 OpenAPI seam 共享 canonical owner `creation`；图片/视频、页面与供应商 adapter 不产生并行业务 owner
- **Server → PostgreSQL**: Server 以单一最小权限角色直连数据库，构造时与每个写事务内验证运行身份（[ADR-0015](./docs/adr/0015-single-tenant-user-system-and-go-authorization.md)）
- **Server → AI 供应商**: 复杂 module 在 infrastructure 中通过 adapter 接入供应商；Webhook 通过 Server 的可信 interface 回传状态（设计归 issue #77）
- **Desktop 内部**: 渲染进程通过 IPC Channel 与主进程通信，类型声明分散在各 domain 的 `shared/ipc/<domain>/types.ts`

完整职责和非目标见 [ADR-0014](./docs/adr/0014-go-sole-trusted-data-plane.md) 与 [ADR-0013](./docs/adr/0013-onprem-single-tenant-delivery.md)。PostgreSQL、AI 供应商与对象存储后端是外部基础设施，不是新的 bounded context。
