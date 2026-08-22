# ADR-0008: 审计驱动写边界与 Identity RLS/GRANT 结构

## 状态

已作废 — 2026-08-22 — 多租户 Organization 与 Supabase Auth 前提随私有化消失。继任决策见 [ADR-0015](0015-single-tenant-user-system-and-go-authorization.md)（单租户用户系统与 Go 层授权；单一最小权限角色、启动与写事务身份验证、Write Transaction Module 契约在该 ADR 中延续）。原文保留如下。

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
- 运行时身份澄清（2026-08-18，identity-execution ticket 01 落地时确认）：`identity_app` 必须以**直接登录**使用——运行时连接的 `session_user`（认证身份）与 `current_user`（执行身份）都必须恰为 `identity_app`，Identity Module 构造时以真实数据库往返验证该 invariant；数据库不可达同样导致构造失败，先于 HTTP listener 与 Worker 启动。owner、migration 或其他高权限凭据即使能 `SET ROLE identity_app` 也不构成合法运行配置，认证身份不能以事务内降级约定替代。本角色仍是唯一运行角色：ADR 不引入第二个执行角色。
- 写事务所有权（2026-08-18，identity-execution ticket 02 落地时确认）：全部 Identity-owned 写事务——Organization、Membership、Invitation、Verification 签发与 Outbox Worker——统一经过 Identity-local 的 Write Transaction Module（`internal/identity/writetx`）：每次事务开始后、业务回调执行前重新验证 `session_user` 与 `current_user` 都恰为 `identity_app`，验证失败即回滚且不执行业务代码；commit/rollback 由该 runner 独占，Lean V1 回调契约为 `func(pgx.Tx) error`——nil 提交、错误回滚、回调完成前观察到的取消阻止提交、panic 尽力回滚并保留、从不自动重放回调。各命令事务内历史的 `SET LOCAL ROLE identity_app` 语句随之移除：直接登录使角色切换成为冗余，且角色切换本就不能把 owner 凭据合法化。该 Module 是 Identity Domain 内的责任命名子包，不提升为 Server 共享数据库层；Outbox Worker 保留其既有的认领、SMTP、重试与投递后提交语义（投递命运一经决定，簿记提交对 shutdown 免疫），Lean V1 不为事务期身份漂移引入终态或进程退出协议。
- 运行时凭据属于部署侧：开发与测试 harness 以一次性随机口令直接登录 `identity_app`（每次运行重置，不落盘）；生产连接串同样必须以 `identity_app` 认证。Go Module 只验证身份，不枚举或修补角色属性/授权——角色契约（非 superuser、无 BYPASSRLS、无管理属性、仅本 ADR 所列 GRANT）仍由 migrations 权威定义并由集成测试按目录与行为分别验证。

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
