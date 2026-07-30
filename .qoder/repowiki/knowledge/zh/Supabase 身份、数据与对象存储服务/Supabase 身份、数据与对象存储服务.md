---
kind: external_dependency
name: Supabase 身份、数据与对象存储服务
slug: supabase
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### Supabase
- 角色：桌面客户端的身份认证（Auth）、PostgreSQL 数据库、对象存储（Storage）和实时订阅（Realtime）服务
- 集成点：`@supabase/supabase-js` SDK，通过用户 JWT 直连受 RLS/Storage Policy 保护的 Supabase
- 使用模式：Desktop 使用 publishable/anon key 直接调用，只有密钥管理、额度/支付、Webhook、管理员权限、事务或异步编排才通过 Go 后端可信执行 seam
- 架构约束：Supabase 是外部基础设施而非新的 bounded context，Go 不是通用代理层
- 验证：具体 API/参数需对照官方文档确认