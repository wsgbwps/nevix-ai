# 01 — 固化 Supabase 与 Go 的架构职责规则

**What to build:** 将已经认可的 Supabase、Go 与 AI 异步任务职责写成项目级架构规则，使后续需求和代码评审能据此判断请求应直连 Supabase，还是进入 Go 的可信执行 seam。本 ticket 只记录规则与非目标，不创建数据库结构、接口、UI、供应商 adapter 或部署资源；任何实现必须另开 ticket。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 规则明确：客户端可使用 publishable/anon key 和用户 JWT，直接访问受 RLS 或 Storage Policy 保护的 Auth、普通 CRUD、Storage 与 Realtime 能力。
- [x] 规则明确：Go 只承担必须位于可信环境中的生成命令、AI 供应商密钥、额度与支付、Webhook、管理员操作和异步任务编排，不成为所有 Supabase 请求的代理层。
- [x] 规则明确：Go 可为事务和后台任务直连 PostgreSQL，但必须使用专用的最小权限角色；客户端不得获得数据库凭据、Supabase secret/service-role key 或第三方供应商密钥。
- [x] 规则明确：对象文件通过 Storage API、签名上传或可恢复上传传输，不直接修改 Storage 内部表，也不让大文件经过 Go；数据库只保存业务状态、稳定 object key 和必要元数据。
- [x] 规则明确：供应商 Webhook 负责向可信后端通知外部状态，必须验签、去重并允许重试；Realtime 只用于向客户端加速展示数据库状态，不充当可靠任务队列。
- [x] 规则明确：开发环境使用内网自托管 Supabase，预发布和生产使用相互隔离的阿里云 RDS Supabase；环境共享 migrations 和规则配置，但不迁移开发测试数据。
- [x] 规则明确：初创阶段保持一个模块化 Go 部署单元，优先利用供应商异步队列和 PostgreSQL；在负载、故障隔离或团队边界提供证据前，不引入 Kafka、Kubernetes、微服务或独立消息基础设施。
- [x] 规则使用项目的 module、interface、seam 和 adapter 领域词汇，并与现有 Context、ADR、README 和代码规则保持一致；如发现冲突，只记录冲突和建议，不在本 ticket 中实施架构改造。
- [x] 验收仅包含架构文档和规则的一致性检查；schema、API、Electron、Go 业务逻辑、云资源和供应商接入均保持不变。
