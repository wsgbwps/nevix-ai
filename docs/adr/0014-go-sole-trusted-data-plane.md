# ADR-0014: Go server 是唯一可信数据面

## 状态

已接受 — 2026-08-22。取代 [ADR-0004](0004-supabase-go-trusted-execution-seam.md) 的 seam 决策（该 ADR 已作废）。

2026-08-26 修订（AI Creation V1 实施规格 [#150](https://github.com/wsgbwps/nevix-ai/issues/150)）：客户部署只接受 https Server URL，取代「放行 RFC1918 http 地址」；TLS 终结与官方公网 Compose 形状改为由 ADR-0013 定义的官方 Nginx 栈，见「TLS 与桌面端连接」。

## 背景

ADR-0004 的 seam 建立在 Desktop 经 publishable key + 用户 JWT 直连 Supabase、由 RLS 保护的前提上。私有化后无 Supabase、无 RLS，数据通路只剩一条：要么 Go 吞下全部数据访问，要么客户端直连数据库。前者有把 Go 退化为表驱动浅代理的风险（ADR-0004 当年刻意避免的形状），后者毁掉凭据纪律。本 ADR 定义新 seam。

## 决策

### 唯一通路与端点形态

- Desktop 不持有任何数据库凭据；全部数据访问——认证、业务 CRUD、文件、推送——经 Go HTTP API，契约在 `contracts/`（OpenAPI）。
- Go API 按业务语义暴露资源端点（vertical slice），不做通用 CRUD 网关：每个端点有业务名字与业务规则落点。API 面的扩张是接受的代价，换取授权与校验有单一落点。
- 写路径延续 trusted command 纪律：需要写 Audit Log 的写操作在写事务内同写审计行。

### 文件出口

- 文件一律经 Go server 出口，不做预签名直连——直连会绕过 Go 层授权。元数据只在 Postgres，Storage 后端是纯 blob 仓（双后端选择见 [ADR-0013](0013-onprem-single-tenant-delivery.md)）。

### 推送通道

- SSE 仅加速展示，真相永远在 Postgres；事件源为生成任务状态迁移（事件词汇与 wire contract 归 [#150](https://github.com/wsgbwps/nevix-ai/issues/150)：事件只表示当前 User 的 creation state 已失效，不携带私有 payload，不实现 Last-Event-ID）。
- 认证经 fetch-stream 携带 Authorization header，token 不进 URL/query。
- 连接生命周期绑定 Session：吊销、停用或登出即断流——Session 吊销后的跨 Module 断流 seam 见 [ADR-0016](0016-ai-creation-v1-trusted-seams.md)。
- 心跳约 20s（防反向代理 idle 断连）；重连成功主动读取服务端事实，不依赖错过的事件重放。读取可依据可靠变化判据补齐当前视图，无需重拉全部历史详情；Desktop 的事件合并、断流轮询条件与停止读取规则归 [Desktop ADR-0005](../../apps/desktop/docs/adr/0005-creation-operation-and-task-refresh-lifetimes.md)。

### TLS 与桌面端连接

- Go server 只听 HTTP，TLS 由部署栈终结：官方公网 Compose 以固定版本/摘要的 Nginx 暴露唯一 HTTPS 443 入口，Go、PostgreSQL、Storage 与管理端口只在 internal network（交付形状与证书生命周期的权威说明见 [ADR-0013](0013-onprem-single-tenant-delivery.md)）。
- Desktop 运行时配置 server URL（不再是构建期烧死）；客户部署只接受 https，显式 development mode 才允许 loopback http。https 自签证书采用 TOFU 指纹钉扎——首连由用户与独立渠道获得的指纹核对后确认并按 host/IP 持久 pin；证书变化、IP 变化、损坏或显式轮换要求重新确认，任何路径不得全局跳过证书验证。

### 数据库凭据纪律

- 延续单一最小权限 LOGIN 角色（沿袭 `identity_app`）直接登录；启动时验证 `session_user = current_user`，每个写事务内复验；owner/migration 凭据跑应用非法。细节见 [ADR-0015](0015-single-tenant-user-system-and-go-authorization.md)。
- 客户端永远拿不到 PostgreSQL 凭据或任何第三方供应商密钥（沿袭 ADR-0004 原则）。

### 部署单元

- 延续单一模块化 Go 部署单元；负载、故障隔离或团队所有权提供可验证证据之前，不引入消息中间件、Kubernetes 或微服务。

## Considered Options

- **通用 CRUD 网关（表驱动 API）**：API 面等于数据面，授权与业务规则失去落点，等于自建 PostgREST；否决。
- **客户端直连 Postgres**：凭据暴露 + 连接风暴，违反凭据纪律；否决。
- **Server 内置 TLS**：compose 与证书轮换都变成我们的支持工单；官方公网 Compose 以固定 Nginx 终结 TLS，Go 保持只听 HTTP（2026-08-26 修订后仍是本决策）。否决。
- **WebSocket**：v1 无真实双向/高频需求，SSE 覆盖单向下行；出现需求时另立 ADR。

## 后果

- `contracts/` 的 OpenAPI 面显著扩大（原直读路径全部 API 化），每个端点须有业务语义命名。
- 读路径延迟增加（内网单跳，画像内可接受）；SSE 使 Go 成为展示加速的单点，但真相在 Postgres，断流可恢复。
- 外部供应商状态进入可信后端的可靠通道是幂等完成 seam：V1 以异步提交与查询收敛，重复 poll/完成/取消不产生重复副作用；在 Kapon 官方 webhook endpoint、签名与重放合同获得证据前不创建 route、表或猜测性验签，未来 webhook 必须复用同一幂等完成 seam并保持验签、去重、幂等（原则沿袭 ADR-0004，[#150](https://github.com/wsgbwps/nevix-ai/issues/150)）。

## 非目标

- 本决策不定义创作域 API 或 Storage adapter 实现；creation 域的可信 seam 基线见 [ADR-0016](0016-ai-creation-v1-trusted-seams.md)，其余归对应域的 tickets。
