# Define the Alibaba RDS Compatibility Gate

Type: research
Status: resolved
Blocked by: none
Research branch: `research/identity-alibaba-rds-gate`

## Question

在不把阿里云基础设施初始化塞进业务 migrations 的前提下，未来 Supabase 服务栈接入阿里云 RDS PostgreSQL 前必须验证哪些版本、extension、role/schema、逻辑复制、TLS、连接、备份恢复和端到端行为，才能形成可执行的独立基础设施 gate？

## Answer

当前结论为 **conditional no-go**：Supabase Compose 支持配置 external PostgreSQL host，但没有官方证据证明阿里云 RDS 是直接兼容的替代品。正式放行必须由一次生产等价的 disposable RDS 演练证明：

- 精确 PostgreSQL/Supabase 版本、镜像 digest 与启用功能已固定。
- RDS 的 `pg_rds_superuser` 权限模型能复现所需 roles、memberships、ownership、default ACL、`BYPASSRLS` 与服务登录行为。
- 所需 extensions、functions、preload libraries、逻辑复制、publication/slots 均可用。
- 所有服务和 Go 使用证书校验的 TLS，连接预算、故障切换、PITR 和备份恢复经过演练。
- Auth/JWKS、Data API/RLS、Storage、Realtime、Go 事务与 Outbox 的端到端测试全部通过。
- Supabase foundation bootstrap 是独立、固定版本的基础设施资产；业务 migrations 不创建或修复 Supabase 内部角色、schema、extension 或 vendor migration state。

完整引用研究资产位于 `research/identity-alibaba-rds-gate` 分支，commit `e5f5bc05ba5f3fac8bdc105b05544de31834c0f5` 的 `.scratch/identity-v1/research/alibaba-rds-compatibility-gate.md`。
