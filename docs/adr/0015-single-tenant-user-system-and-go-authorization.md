# ADR-0015: 单租户用户系统与 Go 层授权

## 状态

已接受 — 2026-08-22。取代 [ADR-0008](0008-identity-write-boundary-and-rls-grant-structure.md) 的写边界与 RLS/GRANT 结构（该 ADR 已作废）。

2026-08-23 修订：账号进入改为双通道（管理员建号 + 加入码自注册），Bootstrap 改为「首启设置码向导 + 环境变量双通道，先到先得」；见「账号生命周期」与「Considered Options」。

2026-08-24 修订：Bootstrap 收敛为独立的 Instance Claim（实例认领）；默认无凭据，设置码成为可选部署保护，环境变量管理员通道删除。V1 不提供离线 Admin 恢复，也不保留旧 Bootstrap 审计动作。

2026-08-25 修订：Write Transaction Module 回调契约升级为 narrow scope（当前事务 + AfterCommit 登记提交后 effect）；见「写事务纪律」。

2026-08-26 修订（AI Creation V1 实施规格 [#150](https://github.com/wsgbwps/nevix-ai/issues/150)）：可见性模型中「创作数据全体活跃用户可读」被 creator-private / team-readable 模型取代；Session 吊销后断流与 Creation 消费认证结果的 seam 定型；见「可见性模型」「Go 层授权词汇」与「写事务纪律」。

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

- 空实例的首个 User 只通过 Instance Claim 进入并成为 active Admin；认领者自设密码，故不设 `must_change_password`。
- 初始化后的建号双通道：Admin 建号 + 初始密码，`must_change_password` 强制首登改密；或凭加入码自注册——密码本人自设，故不设 `must_change_password`，落地即 active Member。普通注册永远不会因“恰好是首个请求”隐式升级为 Admin。
- 加入码（修订）：Admin 签发的注册码，多枚并存（活跃上限 3）、可吊销、可复用；明文存于 `join_codes` 表——能读库者本可直接写 `users`，明文不降低真实安全性；无活跃码即自注册关闭，不设独立注册开关；email 冲突答 409，席位闸门与管理员建号同一语义（ADR-0013：只阻新建号）。
- 离职 = 停用（disable）：吊销全部 Session、断 SSE；删除仅限「建错且从未登录」的号。
- 最后一个活跃 admin 不可自降级、不可自停用。
- 密码策略：仅最小长度；登录与注册失败限速均用进程内计数（单实例、200–300 用户画像内成立）。

### Instance Claim（实例认领）

- 初始化状态只由 `public.users` 是否存在任何行决定，不新增永久初始化表。产品路径禁止移除最后一个活跃 Admin；主动清空或重建数据库等同创建全新实例。
- 公共状态端点返回 `initialized` 与 `setup_code_required`。Desktop 在未初始化时显示首位管理员向导；状态探测失败时显示可重试错误，不回退到注定无法成功的普通登录。
- 公共认领命令收集 email、密码与可选显示名；`setup_code` 仅在部署要求时必填。成功后创建首个 active Admin、直接签发 Session，并写 `instance_claimed` 审计动作；并发输家收到 409 后回到普通登录。
- `NEVIX_SETUP_CODE_REQUIRED` 是启动时读取的布尔配置：未设置或 `false` 时默认无凭据认领，`true` 时要求设置码，其他值拒绝启动。空实例可修改配置并重启切换保护方式；实例初始化后该配置不再产生效果或设置码。
- 需要设置码时，进程仅在空实例启动时生成随机一次性码，保存在内存并只向运维日志披露一次；空实例重启即换码，认领成功立即从内存清除。设置码不持久化。
- `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` 环境变量 Bootstrap 删除；检测到任一旧变量即拒绝启动并提示改用 `NEVIX_SETUP_CODE_REQUIRED`，不静默忽略。
- 认领写事务以 advisory lock 串行化，并在锁内复检空表；只有首个请求能创建 Admin，任何 User 存在后均不可再次认领。默认开放认领依赖部署方先完成认领再广泛暴露 Server URL，不增加 IP、网段或端口推断。

### Admin 连续性

- V1 不提供离线密码恢复子命令、恢复码或重新开放认领的旁路；Audit Actor 继续只表示实际执行受审计操作的 User，不引入 `host_operator` 或系统操作者。
- 上线前认领错误时重建尚无业务数据的空实例；初始化后不允许重新认领。部署验收建议客户保留至少两名 Admin，但产品不强制，也不增加界面提醒。
- 所有 Admin 均失联时无法通过产品恢复管理权限，是 V1 明确接受的低概率运维风险。

### Session

- opaque token：客户端只持有 token 本体，Postgres sessions 表存 hash；可吊销、多设备并存、30 天滑动过期。
- 改密（本人改或 admin 重置）吊销该用户全部其他 Session；吊销、停用即刻生效。
- 选 opaque 而非 JWT：「即刻踢下线」是硬需求，JWT 需要额外 denylist，等于有状态还多一层。

### Go 层授权词汇

- 两个路由 guard：`RequireActiveUser`（Session → users.status=active）、`RequireAdmin`（users.role=admin）；行级归属检查（如「只能改自己的行」）不进入 guard 词汇，由 owning Module 自己执行——Identity 落在 handler 内，Creation 落在其查询层与命令层（[ADR-0016](0016-ai-creation-v1-trusted-seams.md)）。
- 其他 Module（如 Creation）消费认证结果与 Reauthentication Proof 时不 deep-import Identity implementation：由 composition root 注入窄 public interface（authenticated principal 与 exact-action proof），Creation route 同样显式声明 guard；消费语义见 [ADR-0016](0016-ai-creation-v1-trusted-seams.md)。
- 收敛在单一 authz 小包，全部路由声明式挂 guard；不建策略引擎、不建 allow-table。
- 可见性规则单一落点：authz 包 + 查询层，不散落 handler——将来引入部门隔离时是改一处词汇的迁移，不是全库大扫荡。部门隔离 v1 不做（无实锤客户需求），立专项 issue。

### 可见性模型（v1）

- 用户目录：所有活跃用户可见全部活跃用户（email + display_name）。
- Audit Log：admin-only。
- 创作数据（2026-08-26 修订，取代「全体活跃用户可读」）：Creation Session、Reference Material、Generation Task、Generation Specification、Generation Result 与 Result Slot 对创建者私有，成功 Media Asset 与有效 Team Publication 对全体 active User 可见；Admin 治理不是读取私有内容的旁路。权威模型与聚合级规则见 [ADR-0016](0016-ai-creation-v1-trusted-seams.md)。
- SSE hub 只推订阅者自己的事件。

### 写事务纪律（延续 ADR-0008）

- 单一最小权限 LOGIN 角色（沿袭 `identity_app` 命名）直接登录；`session_user = current_user` 在构造时真实数据库往返验证、每个写事务开始后复验，失败即回滚且不执行业务代码。
- Write Transaction Module 独占事务开始、commit 与 rollback 的契约不变；覆盖面改为用户、会话与审计写路径。
- 2026-08-25 修订（#139）：写事务回调收到的不再是裸事务参数，而是 narrow scope——只暴露当前活动事务（`pgx.Tx`）与 AfterCommit effect 登记两个能力；Module 仍独占 begin、执行身份验证、commit、rollback、取消与 panic 处理，调用方不得自行 begin/commit/rollback/重试或嵌套事务。AfterCommit effect 仅在成功 commit 后各执行一次、按登记顺序同步执行；回调错误、取消阻止提交、panic、rollback 或 commit failure 时一律不执行。effect 运行时事务已提交：effect 失败不改变已提交结果，effect panic 按编程错误原样传播、其后 effect 不再运行。提交后断流等物理 effect 由各自 owner 引入（#138：Session 确定受影响 Session，Write Transaction 保证 commit-before-effect）；Creation 侧断流 seam 已定型——Identity 在 Session 吊销事务成功提交后经共享 Domain Event 发布受影响的非敏感 Session identity，Creation 的 SSE hub 订阅并断开精确流，回滚不发布，见 [ADR-0016](0016-ai-creation-v1-trusted-seams.md)。

### 实例认领审计

- Instance Claim 只写 `instance_claimed`，actor 为新建的首个 Admin，metadata 记录 `setup_code_required: true|false`；Audit Actor 的 User 快照与不可变语义继续遵循 [ADR-0009](0009-audit-log-snapshot-and-immutability.md)。
- 产品尚未上线，没有需要兼容的历史审计数据；`bootstrap_admin_created` 与 `setup_admin_created` 直接从合法 action 词汇删除，不保留只读兼容。
- 本地和测试数据库可直接重建以清除旧 action，不增加清理 migration；此例外不改变新基线之后其余持久化变更遵循 up-only migration 的规则。

## Considered Options

- **无状态 JWT**：见 Session 节；否决。
- **三级角色（+viewer）**：单租户管理员建号场景下是想象需求；enum 加值是兼容迁移，有实锤再加。否决。
- **DB 触发器写审计**：沿袭 ADR-0008 的否决理由——审计语义须与写事务同编排，触发器表达不了。否决。
- **保留 RLS 作为纵深防御**：无客户端直读后 RLS 无评估主体（单一应用角色下策略只能放行），guard + GRANT 已覆盖；否决。
- **内置不可删除的超级管理员**（2026-08-23）：变相恢复已否决的第三级角色，且制造一个永久已知的暴力破解靶子；否决。
- **永久开放的 Member 注册（无凭据门槛）**（2026-08-23）：当时 v1 可见性为全体成员可读全部业务数据，等于向任何拿到 Server URL 的人持续敞开；否决。该可见性前提已被 2026-08-26 creator-private 修订取代，但开放注册仍因用户目录与 team-readable 资产的暴露继续否决。只在无任何 User 时存在且成功一次后永久关闭的 Instance Claim 不属于普通注册。
- **邮箱域名白名单 / 注册后待审批 / CSV 批量建号**（2026-08-23）：分别败于客户邮箱域不统一、审批队列在无邮件通道下无通知手段、初始密码仍需人工逐个传递；均否决。
- **设置码持久化到库**（2026-08-23）：换来「重启不换码」这一无人需要的性质，却新增一张表与清理语义；否决。
- **设置码强制必填**（2026-08-24）：要求部署方查看日志并向客户传码，为常规内网部署增加交接步骤；默认无凭据认领，设置码仅作为显式启用的额外保护。
- **环境变量创建首个 Admin**（2026-08-24）：需要预设并传递初始凭据，且与交互认领形成竞争通道；可选设置码已经覆盖 headless 场景需要的额外保护，故删除。
- **永久初始化标记**（2026-08-24）：应用已禁止移除最后一个活跃 Admin，另存标记会制造“标记已初始化但 users 为空”的分裂状态；以 User 是否存在为唯一真相。
- **离线 Admin 恢复 / 恢复码**（2026-08-24）：新增第二条高权限写通道和新的审计主体模型，成本高于 V1 低概率失联风险；不采用。双 Admin 仅作为部署验收建议，不做硬约束。

## 后果

- 授权的正确性从「数据库策略 + 集成测试」移到「Go guard + 集成测试」：每个路由挂对 guard、每类可见性有集成测试，成为切片门禁。
- Session/账号卫生规则（改密吊销、停用断流、末位 admin 保护）全部进 auth module 集成测试。
- 桌面端 authentication/organization/profile features 重造为 Go API 客户端；E2E/integration harness 的 Supabase 栈拆除重建。
- 审计读取改为经 Go API 分页（原 RLS 直读消失），admin-only，本地导出保留（ADR-0009 修订）。
- 自注册与首启初始化各自构成独立交付切片，全部新端点（注册、初始化、状态、加入码管理）进 OpenAPI 契约。
- Seam A 的认领测试族覆盖默认无凭据、设置码保护、非法布尔配置、旧环境变量拒绝、并发 first-wins、重启换码与单一 `instance_claimed` 审计；不再覆盖环境 Bootstrap 竞态。Desktop 首位管理员向导及并发输家回到登录进入 Seam B E2E。
- E2E 与集成测试基础设施改用 Instance Claim 初始化测试 Admin，不再依赖环境变量 Bootstrap；本地和测试数据库随切片重建，不添加审计清理 migration。
- `server/CONTEXT.md` 词典同步：User 纳入 Instance Claim 入口，明确 Instance Claim 与可选 Setup Code，并保持 Audit Actor 只表示 User。
