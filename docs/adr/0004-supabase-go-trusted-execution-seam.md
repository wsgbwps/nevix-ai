# ADR-0004: Supabase 数据平面与 Go 可信执行 seam

## 状态

已接受 — 2026-07-23

## 背景

Nevix AI 既需要 Supabase 的 Auth、PostgreSQL、Storage 和 Realtime，也需要 Go 管理 AI 供应商、计费和异步生成。如果所有数据请求都经过 Go，Go 会变成与 Supabase interface 几乎等大的浅代理 module；如果客户端又能执行特权操作，供应商密钥、支付、额度和管理员能力就无法保护。

因此将“是否必须位于可信环境”定为 seam：受用户身份与数据策略完整保护的数据操作直达 Supabase，需要特权、密钥或可靠编排的命令进入 Go。本 ADR 中的 **interface** 指调用方正确使用 module 所需知道的完整契约，不只是 Go 目录名或语言类型。

## 决策

### 请求职责

- Desktop 可以使用 Supabase publishable/anon key 和当前用户 JWT，直接调用受 RLS 或 Storage Policy 保护的 Auth、普通 CRUD、Supabase Storage 和 Realtime interface。
- Go 只接收必须跨入可信执行 seam 的命令：生成任务、AI 供应商密钥、额度与支付执行、Webhook、管理员操作、跨写入事务和异步任务编排。Go 不成为所有 Supabase 请求的代理 module。
- 复杂 Go module 对上暴露小而完整的 interface，供应商差异放在 infrastructure adapter 中。只有实际出现第二个 adapter 时才抽取新 interface，与 [ADR-0003](0003-complexity-driven-ddd-layering.md) 保持一致。

### 凭据与数据库

- 客户端永远不得获得 PostgreSQL 凭据、Supabase secret/service-role key 或任何第三方供应商密钥。publishable/anon key 只与用户 JWT 和服务端策略共同工作，不替代 RLS 或 Storage Policy。
- Go 可以为事务和后台任务直连 PostgreSQL，但每个用途使用专用、最小权限角色，不以 service-role 或数据库 owner 作为默认运行凭据。

### 对象与状态传递

- 文件通过 Supabase Storage interface、签名上传或可恢复上传传输。不直接修改 Supabase Storage 内部表，不让大文件经过 Go；业务表只保存业务状态、稳定 object key 和必要元数据。
- 供应商 Webhook 是外部状态进入可信后端的可靠 interface，必须验签、去重、幂等并允许重试。Go 先持久化状态，Realtime 只用于加速 Desktop 展示已持久化的状态。
- Realtime 不充当可靠任务队列，也不替代 `pkg/event/` 中 Go module 之间的 Domain Event。

### 环境与部署形状

- 开发环境使用内网自托管 Supabase。预发布与生产各自使用隔离的 Supabase 服务栈，并分别连接独立的阿里云 RDS PostgreSQL 实例。所有环境共享 migrations 和策略配置，但开发测试数据不迁移到预发布或生产。具体网络、扩展兼容性和部署资源由独立 ticket 验证。
- 初创阶段保持一个模块化 Go 部署单元，优先利用供应商异步队列与 PostgreSQL。在负载、故障隔离或团队所有权提供可验证证据之前，不引入 Kafka、Kubernetes、微服务或独立消息基础设施。

## 后果

- 客户端 CRUD 保留 Supabase 的低延迟与策略模型，Go module 的 interface 只暴露能赚取复杂度的可信命令，而不复制 Supabase interface。
- RLS、Storage Policy、最小权限角色、Webhook 幂等性和状态持久化成为必须验证的安全与可靠性契约，不能依赖客户端约定。
- 日后如果证据要求新的 adapter 或分布式基础设施，应重新打开本 ADR，而不在功能 PR 中顺便改变 seam。

## 非目标

本决策不定义或创建 schema、RLS/Storage Policy 实现、HTTP/IPC interface、Electron 功能、Go 业务逻辑、供应商 adapter、数据迁移、阿里云资源或部署脚本。这些实现必须各自建立 ticket，并通过本 ADR 中的职责 seam 审查。
