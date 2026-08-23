# ADR-0015: 单租户用户系统与 Go 层授权

## 状态

已接受 — 2026-08-22。取代 [ADR-0008](0008-identity-write-boundary-and-rls-grant-structure.md) 的写边界与 RLS/GRANT 结构（该 ADR 已作废）。

2026-08-23 修订：账号进入改为双通道（管理员建号 + 加入码自注册），Bootstrap 改为「首启设置码向导 + 环境变量双通道，先到先得」；见「账号生命周期」与「Considered Options」。

## 背景

ADR-0008 以多租户 Organization 与 Supabase Auth（anon/authenticated JWT）为前提：客户端直读受 RLS 保护的表，Go 以 `identity_app` 执行 trusted writes。私有化单租户后，Supabase Auth 退场、auth 收进 Go server，客户端直读消失——RLS 失去评估主体，授权必须在 Go 层重建，数据库 GRANT 成为唯一 DB 侧防线。

## 决策

### 用户模型与 schema

- 单表 `public.users`：email（唯一登录标识，admin-only 可改）、password_hash（argon2/bcrypt）、display_name（本人可改）、role（`admin|member` 两级，原 owner 并入 admin）、status（`active|disabled`）、must_change_password。
- `public.profiles` 并入 users；`identity` schema 取消，全部表进 `public`。
- 删除：`organizations`、`memberships`、`invitations`、`identity.verification_codes`、`identity.outbox_messages` 及 Outbox Worker 整体（邮件体系连根拔，[ADR-0006](0006-outbox-relay-extraction-trigger.md) 随之作废）。
- 新增 `public.sessions`（见下）与 `public.join_codes`（加入码自注册，2026-08-23 修订）。`audit_logs` 去 organization 维度，快照与不可变语义不变（[ADR-0009](0009-audit-log-snapshot-and-immutability.md) 修订）。
- RLS 整体移除，不保留为第二防线：单一应用角色下策略只能 permissive-true（ADR-0008 时期 `identity_app` policy 已是如此），维持 RLS 只剩维护成本。
- 无生产数据：v1 不做数据迁移，schema drop-rebuild 建新基线；此后 up-only migration 从新基线起版（见 [ADR-0013](0013-onprem-single-tenant-delivery.md)）。

### 账号生命周期

- 建号双通道（修订）：管理员建号 + 初始密码，`must_change_password` 强制首登改密；或凭加入码自注册——密码本人自设，故不设 `must_change_password`，落地即 active member。
- 加入码（修订）：Admin 签发的注册码，多枚并存（活跃上限 3）、可吊销、可复用；明文存于 `join_codes` 表——能读库者本可直接写 `users`，明文不降低真实安全性；无活跃码即自注册关闭，不设独立注册开关；email 冲突答 409，席位闸门与管理员建号同一语义（ADR-0013：只阻新建号）。
- 离职 = 停用（disable）：吊销全部 Session、断 SSE；删除仅限「建错且从未登录」的号。
- 最后一个活跃 admin 不可自降级、不可自停用。
- 密码策略：仅最小长度；登录与注册失败限速均用进程内计数（单实例、200–300 用户画像内成立）。
- Bootstrap（修订）：空库时进程生成一次性「设置码」，仅在运维日志披露一次，持有者经首启向导自选凭据成为首个 admin（密码自设，无 `must_change_password`）；进程重启且仍空库则换新码、旧码作废；环境变量通道（`ADMIN_EMAIL`/`ADMIN_INITIAL_PASSWORD`）保留给 headless 交付与 E2E；两通道先到先得，初始化写事务内以 advisory lock 复检空库串行化，输家答 409；任何 User 存在后设置码不复存在。

### Session

- opaque token：客户端只持有 token 本体，Postgres sessions 表存 hash；可吊销、多设备并存、30 天滑动过期。
- 改密（本人改或 admin 重置）吊销该用户全部其他 Session；吊销、停用即刻生效。
- 选 opaque 而非 JWT：「即刻踢下线」是硬需求，JWT 需要额外 denylist，等于有状态还多一层。

### Go 层授权词汇

- 两个路由 guard：`RequireActiveUser`（Session → users.status=active）、`RequireAdmin`（users.role=admin）；行级归属检查（如「只能改自己的行」）留在 handler 内。
- 收敛在单一 authz 小包，全部路由声明式挂 guard；不建策略引擎、不建 allow-table。
- 可见性规则单一落点：authz 包 + 查询层，不散落 handler——将来引入部门隔离时是改一处词汇的迁移，不是全库大扫荡。部门隔离 v1 不做（无实锤客户需求），立专项 issue。

### 可见性模型（v1，团队共享）

- 用户目录：所有活跃用户可见全部活跃用户（email + display_name）。
- Audit Log：admin-only。
- 创作数据：全体活跃用户可读，owner 与 admin 可写删。
- SSE hub 只推订阅者自己的任务事件。

### 写事务纪律（延续 ADR-0008）

- 单一最小权限 LOGIN 角色（沿袭 `identity_app` 命名）直接登录；`session_user = current_user` 在构造时真实数据库往返验证、每个写事务开始后复验，失败即回滚且不执行业务代码。
- Write Transaction Module 独占事务开始、commit 与 rollback 的契约不变；覆盖面改为用户、会话与审计写路径。

## Considered Options

- **无状态 JWT**：见 Session 节；否决。
- **三级角色（+viewer）**：单租户管理员建号场景下是想象需求；enum 加值是兼容迁移，有实锤再加。否决。
- **DB 触发器写审计**：沿袭 ADR-0008 的否决理由——审计语义须与写事务同编排，触发器表达不了。否决。
- **保留 RLS 作为纵深防御**：无客户端直读后 RLS 无评估主体（单一应用角色下策略只能放行），guard + GRANT 已覆盖；否决。
- **内置不可删除的超级管理员**（2026-08-23）：变相恢复已否决的第三级角色，且制造一个永久已知的暴力破解靶子；否决。
- **开放注册（无凭据门槛）**（2026-08-23）：v1 可见性为全体成员可读全部业务数据，等于向任何拿到 server URL 的人敞开；否决。
- **邮箱域名白名单 / 注册后待审批 / CSV 批量建号**（2026-08-23）：分别败于客户邮箱域不统一、审批队列在无邮件通道下无通知手段、初始密码仍需人工逐个传递；均否决。
- **设置码持久化到库**（2026-08-23）：换来「重启不换码」这一无人需要的性质，却新增一张表与清理语义；否决。

## 后果

- 授权的正确性从「数据库策略 + 集成测试」移到「Go guard + 集成测试」：每个路由挂对 guard、每类可见性有集成测试，成为切片门禁。
- Session/账号卫生规则（改密吊销、停用断流、末位 admin 保护）全部进 auth module 集成测试。
- 桌面端 authentication/organization/profile features 重造为 Go API 客户端；E2E/integration harness 的 Supabase 栈拆除重建。
- 审计读取改为经 Go API 分页（原 RLS 直读消失），admin-only，本地导出保留（ADR-0009 修订）。
- 自注册与首启初始化各自构成独立交付切片，全部新端点（注册、初始化、状态、加入码管理）进 OpenAPI 契约。
- Seam A 新增测试族：注册成功/码错/email 冲突/限速/审计、加入码活跃上限、初始化先到先得（含 env 通道竞态）与重启换码；桌面端登录屏注册入口与首启向导进 Seam B E2E。
- `server/CONTEXT.md` 词典同步：User 改双通道进入，Admin 增加入码治理，新增 Join Code / Setup Code 词条。
