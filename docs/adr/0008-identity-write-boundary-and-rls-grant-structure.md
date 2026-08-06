# ADR-0008: 审计驱动写边界与 Identity RLS/GRANT 结构

## 状态

已接受 — 2026-08-05

## 背景

Organization Membership 切片首次让 Desktop client 直读五张共享表（profiles/organizations/memberships/invitations/audit_logs）。按 [ADR-0004](0004-supabase-go-trusted-execution-seam.md) 的 seam，受 RLS 保护的读直达 Supabase；但这些表的写操作几乎都需要同时写 Audit Log 或 Outbox——如果 client 能直写，审计与通知的完整性就只能依赖客户端约定。

## 决策

### 写边界

- 任何需要写 Audit Log 或 Outbox 的写操作一律是 Go trusted command；memberships/organizations/invitations/audit_logs 对 client 为 SELECT-only。
- 唯一例外：client 可写 profiles（INSERT/UPDATE 本人行），因为它不产生审计行或通知。
- 该边界由 RLS/GRANT 强制执行，不靠客户端自觉。

### Schema 与角色

- client 可读五表放 `public` schema 并全部 ENABLE RLS；Go-only 表（verification_codes/outbox_messages）留 `identity` schema；不修改 `api.schemas`，对 Supabase 托管 schema 零改动。
- Go 使用单一 `identity_app` LOGIN 角色承载命令、Outbox Worker 与 retention sweep，不按用途拆角色；不授 BYPASSRLS，改在五张 public 表上对 identity_app 加 permissive policy（USING true），RLS 保持全局兜底。
- 邮箱解析经 `identity.directory (id,email)` security definer 只读视图引用 auth.users，GRANT SELECT 仅 identity_app。

### RLS helper 词汇

- 授权判断收敛为三个 security definer helper：`is_active_member(org_id)`、`has_org_role(org_id, roles[])`、`shares_active_org(user_id)`，放 identity schema、`search_path=''`、函数体内 `(select auth.uid())`，对 PUBLIC/anon/authenticated 撤销 EXECUTE。
  - 实施澄清（2026-08-06，ticket 01 落地时确认）：PostgreSQL 以**评估策略的调用角色**检查函数 EXECUTE 权限，`authenticated` 必须持有 EXECUTE 否则 RLS 策略无法求值，故对 `authenticated`（与 `identity_app`）授 EXECUTE、对 PUBLIC/anon 显式撤销——撤销意图不变，唯一调整是 authenticated 的 EXECUTE 为策略求值所必需。helper 不暴露为 Data API RPC（identity schema 不在 api.schemas），authenticated 直调 helper 仅能查询自身授权布尔值，无越权面。
- 策略结构：profiles 本人或活跃同组织成员可见；organizations 活跃成员可见；memberships 本人行（含已结束）+ 本组织活跃行；invitations Owner/Admin 或 `email = jwt email` 的 pending 行；audit_logs Owner/Admin 只读。即时失权由"只读活行"天然满足。

## Considered Options

- **client 直写 membership 类表 + DB 触发器写审计**：触发器把审计语义埋进数据库，与 Outbox 同事务的编排（如 AcceptInvitation 五步单事务）在触发器内无法表达；否决。
- **Go 使用 service-role 或 BYPASSRLS 角色**：失去 RLS 作为第二道防线，与 ADR-0004 的最小权限凭据原则冲突；否决。
- **按用途拆多个 Go 角色**（命令/Worker/sweep 各一）：现阶段三者的表权限几乎相同，拆分只增运维面；出现权限分化证据时再拆。
- **RLS 策略内联子查询而非 helper 函数**：每个策略重复同一授权逻辑，改授权词汇要动全部策略；helper 是唯一授权词汇的落点。

## 后果

- 审计与通知完整性成为数据库层强制契约；未来新增"client 可读表"默认 SELECT-only，写路径必须显式论证是否需要审计/通知。
- 未来 Governance 切片的 security-state 表沿用同构模式（public + RLS + identity_app permissive policy）。
- RLS helper 改动影响全部五表策略，须配套 RLS 集成测试（真实 anon/authenticated token）作为切片门禁。
