# ADR-0014: Go server 是唯一可信数据面

## 状态

已接受 — 2026-08-22。取代 [ADR-0004](0004-supabase-go-trusted-execution-seam.md) 的 seam 决策（该 ADR 已作废）。

2026-08-26 修订（AI Creation V1 实施规格 [#150](https://github.com/wsgbwps/nevix-ai/issues/150)）：客户部署只接受 https Server URL，取代「放行 RFC1918 http 地址」；TLS 终结与官方公网 Compose 形状改为由 ADR-0013 定义的官方 Nginx 栈，见「TLS 与桌面端连接」。

2026-09-08 修订（规格 [#215](https://github.com/wsgbwps/nevix-ai/issues/215)，[#214](https://github.com/wsgbwps/nevix-ai/issues/214) 前置）：Go 继续独占文件授权、元数据与 finalize，但永久 Reference Material 上传改为 Go 签发的 creator-private 单对象预签名 PUT；Desktop 不获得 AK/SK、任意 key 或读/List/Delete 能力。Provider Transfer Object 的限时供应商 GET 同属 Go 授权的窄例外。

2026-09-09 修订（[#218](https://github.com/wsgbwps/nevix-ai/issues/218)，后续实现归 [#220](https://github.com/wsgbwps/nevix-ai/issues/220)）：预签名 PUT 的字节传输由 Renderer `fetch` 改为 Electron Main 原生流式请求。Renderer 只选择文件并展示进度/结果，Preload 只把 `webUtils.getPathForFile(file)` 得到的路径经窄 IPC 交给 Main 且不回传 Renderer；Go 的签名、授权、finalize 与 HEAD/内容校验责任不变。

## 背景

ADR-0004 的 seam 建立在 Desktop 经 publishable key + 用户 JWT 直连 Supabase、由 RLS 保护的前提上。私有化后无 Supabase、无 RLS，数据通路只剩一条：要么 Go 吞下全部数据访问，要么客户端直连数据库。前者有把 Go 退化为表驱动浅代理的风险（ADR-0004 当年刻意避免的形状），后者毁掉凭据纪律。本 ADR 定义新 seam。

## 决策

### 唯一通路与端点形态

- Desktop 不持有任何数据库凭据；认证、业务 CRUD、文件授权与元数据、下载和推送都经 Go HTTP API，契约在 `contracts/`（OpenAPI）。唯一字节直连例外是 Go 已授权并限定为单一对象写入的 Reference Material Upload，不能扩张为客户端 Storage 数据面。
- Go API 按业务语义暴露资源端点（vertical slice），不做通用 CRUD 网关：每个端点有业务名字与业务规则落点。API 面的扩张是接受的代价，换取授权与校验有单一落点。
- 写路径延续 trusted command 纪律：需要写 Audit Log 的写操作在写事务内同写审计行。

### 文件授权与传输

- Go 是文件授权和元数据的唯一可信数据面。每个 Deployment Instance 最多一条 OSS 或 COS Object Storage Connection；元数据只在 PostgreSQL，bucket 是纯 blob 仓（交付与配置见 [ADR-0013](0013-onprem-single-tenant-delivery.md)）。
- Creation Module 独占 Object Storage Connection 配置、凭据加密、provider 选择与 canary、短期 URL 签名、权威 finalize、读取授权和精确 key 清理；Desktop 只承担设置交互与已授权 PUT，不引入 Storage Domain 或第二条可信数据面。
- 永久 Reference Material 上传采用三步窄 seam：Creator 向 Go 申请 Reference Material Upload；Electron Main 只凭 60 分钟、随机精确 key、固定 PUT 方法、固定请求头且禁止覆盖的预签名 URL 从本地磁盘流式写入当前 bucket；Desktop 再向 Go finalize。Go 校验 authenticated Creator 与 Creation Session ownership，HEAD 后完整有界读取、媒体 probe、实际 kind 限额和 SHA-256 全部通过，才在 verified write transaction 中创建 immutable Reference Material。
- Renderer 只向专用 Preload 桥传入用户选择的 `File` 并接收进度、取消结果与最终结果；Preload 使用 `webUtils.getPathForFile(file)` 取得磁盘路径，经窄类型 IPC 交给 Main，绝不把完整路径返回 Renderer，也不把完整文件转为 ArrayBuffer 经 IPC 传输。Main 必须验证可信顶层 Renderer、常规磁盘文件、HTTPS、Go 返回的精确 OSS/COS origin、PUT 方法和闭集签名请求头，拒绝重定向、任意路径、任意 URL、任意方法和额外请求头；V1 直接使用 Main，不增加 Utility Process、自定义 protocol、multipart 或断点续传。
- signed PUT 不授予读、List、Delete、换 key 或第二个对象能力，Desktop 永远拿不到 Access Key/Secret。上传租约 creator-private、持久且单次 finalize；abort、过期或验证失败按精确 key 清理，Admin 无读取或完成他人上传的旁路。
- Reference Material 下载仍经 Go 授权和有界流式出口。Provider Transfer Object 由 Go 从已授权素材派生并为外部 AI Provider 生成限时 HTTPS GET URL；该 URL 不构成 Desktop Storage 权限。
- signed URL 是短期敏感能力：只允许出现在当前授权调用方的内存和必要出站请求中，不持久化，不进入普通日志、Audit Log、错误、剪贴板或遥测。具体状态机与凭据纪律见 [ADR-0016](0016-ai-creation-v1-trusted-seams.md)。

### 推送通道

- SSE 仅加速展示，真相永远在 Postgres；事件源为生成任务状态迁移（事件词汇与 wire contract 归 [#150](https://github.com/wsgbwps/nevix-ai/issues/150)：事件只表示当前 User 的 creation state 已失效，不携带私有 payload，不实现 Last-Event-ID）。
- 认证经 fetch-stream 携带 Authorization header，token 不进 URL/query。
- 连接生命周期绑定 Session：吊销、停用或登出即断流——Session 吊销后的跨 Module 断流 seam 见 [ADR-0016](0016-ai-creation-v1-trusted-seams.md)。
- 心跳约 20s（防反向代理 idle 断连）；重连成功主动读取服务端事实，不依赖错过的事件重放。读取可依据可靠变化判据补齐当前视图，无需重拉全部历史详情；Desktop 的事件合并、断流轮询条件与停止读取规则归 [Desktop ADR-0005](../../apps/desktop/docs/adr/0005-creation-operation-and-task-refresh-lifetimes.md)。

### TLS 与桌面端连接

- Go server 只听 HTTP，TLS 由部署栈终结：官方公网 Compose 以固定版本/摘要的 Nginx 暴露唯一 HTTPS 443 入口，Go、PostgreSQL 与管理端口只在 internal network；Object Storage 是客户预置的外部云资源，Go 与受授权 Electron Main PUT 只访问 Server 推导的官方公网 endpoint（交付形状与证书生命周期的权威说明见 [ADR-0013](0013-onprem-single-tenant-delivery.md)）。
- Desktop 运行时配置 server URL（不再是构建期烧死）；客户部署只接受 https，显式 development mode 才允许 loopback http。https 自签证书采用 TOFU 指纹钉扎——首连由用户与独立渠道获得的指纹核对后确认并按 host/IP 持久 pin；证书变化、IP 变化、损坏或显式轮换要求重新确认，任何路径不得全局跳过证书验证。

### 数据库凭据纪律

- 延续单一最小权限 LOGIN 角色（沿袭 `identity_app`）直接登录；启动时验证 `session_user = current_user`，每个写事务内复验；owner/migration 凭据跑应用非法。细节见 [ADR-0015](0015-single-tenant-user-system-and-go-authorization.md)。
- 客户端永远拿不到 PostgreSQL 凭据、AI Provider Key 或 Object Storage AK/SK；受限预签名 URL 是 Go 授权的短期单对象能力，不是底层凭据。

### 部署单元

- 延续单一模块化 Go 部署单元；负载、故障隔离或团队所有权提供可验证证据之前，不引入消息中间件、Kubernetes 或微服务。

## Considered Options

- **通用 CRUD 网关（表驱动 API）**：API 面等于数据面，授权与业务规则失去落点，等于自建 PostgREST；否决。
- **客户端直连 Postgres**：凭据暴露 + 连接风暴，违反凭据纪律；否决。
- **Server 内置 TLS**：compose 与证书轮换都变成我们的支持工单；官方公网 Compose 以固定 Nginx 终结 TLS，Go 保持只听 HTTP（2026-08-26 修订后仍是本决策）。否决。
- **WebSocket**：v1 无真实双向/高频需求，SSE 覆盖单向下行；出现需求时另立 ADR。
- **永久素材字节继续全部经 Go**（2026-09-08）：授权最简单，但让最大 200 MiB 单次上传持续占用 Go 入站带宽和连接，且客户端到云 bucket 已有安全的原生直传能力。选择数据库租约 + 精确预签名 PUT + Go finalize，在不暴露 AK/SK、不放弃 creator ownership 与权威内容验证的前提下移除代理上传；multipart、断点续传和通用 Storage Grant 仍否决。

## 后果

- `contracts/` 的 OpenAPI 面显著扩大（原直读路径全部 API 化），每个端点须有业务语义命名。
- `contracts/creation.yaml` 增加 Object Storage Connection/capability 与 Reference Material Upload 申请、状态、finalize、abort 合同；原子 multipart Reference Material 上传在同一切片删除，不保留兼容 route。
- 读路径延迟增加（内网单跳，画像内可接受）；SSE 使 Go 成为展示加速的单点，但真相在 Postgres，断流可恢复。
- 外部供应商状态进入可信后端的可靠通道是幂等完成 seam：V1 以异步提交与查询收敛，重复 poll/完成/取消不产生重复副作用；在 Kapon 官方 webhook endpoint、签名与重放合同获得证据前不创建 route、表或猜测性验签，未来 webhook 必须复用同一幂等完成 seam并保持验签、去重、幂等（原则沿袭 ADR-0004，[#150](https://github.com/wsgbwps/nevix-ai/issues/150)）。

## 非目标

- 本决策不定义创作域 API 或 Storage adapter 实现；creation 域的可信 seam 基线见 [ADR-0016](0016-ai-creation-v1-trusted-seams.md)，其余归对应域的 tickets。
