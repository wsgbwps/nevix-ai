# Identity Organization Membership Spec

Status: ready-for-agent（已定稿：prototype 6/6 变体裁决、页面归属指令与共享原语例外已回填，进入 to-tickets）

本 spec 是 Identity V1 第二个交付切片（Organization Membership）及其前置小切片（Identity Foundation 收尾）的实现规格。17 项决策已在 grill-with-docs 会话中锁定，本文档为综合记录，不重开任何已定决策。

Authoritative context:

- [Identity V1 基线 spec](../identity-v1/spec.md) —— 角色模型、Invitation 语义、审计范围、通知矩阵、Go/Desktop 分工为固定基线，本文不重开
- [ADR-0004](../../docs/adr/0004-supabase-go-trusted-execution-seam.md) —— Supabase 数据平面与 Go 可信执行 seam
- [ADR-0008](../../docs/adr/0008-identity-write-boundary-and-rls-grant-structure.md) —— 审计驱动写边界与 Identity RLS/GRANT 结构
- [ADR-0009](../../docs/adr/0009-audit-log-snapshot-and-immutability.md) —— Audit Log 快照归属与不可变性
- [Desktop 术语表](../../apps/desktop/CONTEXT.md)、[Server 术语表](../../server/CONTEXT.md)
- `contracts/openapi.yaml` —— 错误信封 `{error, message}`（snake_case 机器码为唯一程序依据）、契约只增不改

## Problem Statement

阶段 1 已交付注册、验证码、登录、密码恢复与 Session，但 User 完成注册后无法真正使用产品：业务资源归 Organization 所有，而 User 还没有全局 Profile、没有可进入的 Organization，更无法与他人协作。具体痛点：

- 新 User 注册后没有显示名，无法被其他成员识别；也没有创建第一个 Organization 的引导路径。
- 多 Organization 用户每次启动都要重新找组织；设备不记住上次选择。
- Owner/Admin 无法邀请成员、调整角色或移除成员；被邀请人没有加入通道。
- 组织的成员与权限变更没有不可篡改的记录，管理员无法回看或导出安全事件。
- 关键变更（邀请、Admin 变动、被移除）当事人收不到任何通知。

## Solution

交付两个可独立合并、独立回滚的垂直切片：

**前置切片（Identity Foundation 收尾）**：全局 Profile（显示名读写）、First Organization 创建引导（onboarding 作为第四个顶层视图）、Active Organization 状态与设备记忆（启动验证三分支：0 组织进 onboarding / 1 组织自动选中 / N 组织进选择界面，记忆有效则直接进入）。

**Membership 主切片**：Invitation 全生命周期（创建/重发/撤销/接受，携码邮件）、多组织成员与切换、Owner/Admin/Member 三级授权（成员移除、退出、角色变更）、Organization 设置变更、Organization Audit Log 查看与导出、Outbox 通知矩阵落地（5 个模板、单封双语、写入时渲染）。

两个切片共享本会话一次性设计的约定（schema、RLS/GRANT、写边界、传输契约）；前置切片先交付，Membership 切片的 ticket 标注对它的 blocking 边。

## User Stories

### 前置切片：Profile + First Organization + Active Organization

1. As a newly registered User, I want to set my display name, so that other members can recognize me.
2. As a User, I want display name validation (trim 后 1–50 字符、拒绝纯空白), so that member lists stay readable.
3. As a User, I want to edit my display name later, so that my identity stays accurate in every Organization.
4. As a User, I want a default avatar without uploading anything, so that onboarding stays quick.
5. As a newly verified User with no Organization, I want to be guided to create my first Organization, so that I can start using the product.
6. As a User creating an Organization, I want to name it, so that members can identify it.
7. As a User, I want Organization creation to be safe to retry, so that a network failure never creates duplicates.
8. As a returning User with exactly one Organization, I want it auto-selected at startup, so that I reach my work immediately.
9. As a returning User with multiple Organizations, I want my last Active Organization remembered on this device, so that I resume where I left off.
10. As a returning User whose remembered Membership has ended, I want to be asked to select again, so that I never see data I am no longer entitled to.
11. As a User with zero Organizations (e.g. after removal), I want to land on the onboarding view, so that my next step is obvious.

### Membership 切片

12. As an Owner, I want to invite a teammate by email, so that they can join my Organization.
13. As an Admin, I want to invite Members by email, so that team growth does not bottleneck on the Owner.
14. As an Owner or Admin, I want to see pending Invitations, so that I know who has not joined.
15. As an Owner or Admin, I want to resend an Invitation, so that the invitee receives a fresh valid code.
16. As an Owner or Admin, I want to revoke a pending Invitation, so that a mistaken invite can never be accepted.
17. As an Owner or Admin, I want inviting an already-active member's email to be rejected, so that duplicate active Memberships cannot occur.
18. As an invitee, I want to receive the invitation code by email, so that I can join from Desktop.
19. As an invitee with a verified matching email, I want to enter the code in Desktop and join as Member, so that access is bound to my identity.
20. As an invitee, I want each wrong code attempt to consume one of five attempts, so that codes resist brute force.
21. As an invitee, I want expired or invalidated codes rejected clearly, so that I know to request a resend.
22. As a new Member, I want the Organization to appear in my list immediately after acceptance, so that I can switch into it.
23. As a User with pending Invitations addressed to my email, I want them surfaced automatically in Desktop, so that I never need a pure-manual entry point.
24. As a Member or Admin, I want to leave an Organization, so that I can end my participation.
25. As an Owner or Admin, I want to remove a Member, so that the Organization controls its roster.
26. As a removed Member, I want access to end immediately and to be notified by email, so that there is no ambiguity.
27. As an Owner, I want to promote a Member to Admin, so that administration can be delegated.
28. As an Owner, I want to demote or remove an Admin, so that I retain final control.
29. As an affected User or Owner, I want email notification on Admin promotion, demotion, and removal, so that privilege changes are visible even when the actor is the Owner.
30. As an Owner or Admin, I want to update Organization settings (name), so that Organization information stays current.
31. As an Owner or Admin, I want to view the Organization Audit Log, so that I can review security events with who-did-what-when.
32. As an Owner or Admin, I want to export the Audit Log to a local file, so that I can archive or share it.
33. As a Member, I want Audit Log access denied, so that security visibility stays with administrators.
34. As any recipient, I want notification emails to carry both Simplified Chinese and English in one message, so that I understand it regardless of my device language.
35. As a User who loses Membership while the app is running, I want the app to detect it, exit that Organization context, and tell me why, so that I never act on stale access.

## Implementation Decisions

### 切片与交付边界

- 前置切片（Profile + First Organization + Active Organization）与 Membership 主切片各自独立构建、测试、合并、回滚，不引入临时兼容脚手架（spec 硬性要求）。
- Migration 全程 expand-only：回滚 = 回退代码，已应用的表结构可保留。
- 共享区域通报：`contracts/openapi.yaml` 变更按根 AGENTS.md 在 PR 描述中 call out 影响与测试；确需新增共享 shadcn 原语时，ticket 必须显式声明 shared-area 例外并接受附加审查。

### Schema 与数据模型

- client 可读五表进 `public` schema（RLS 保护）：profiles / organizations / memberships / invitations / audit_logs。Go-only 两表留 `identity` schema：verification_codes / outbox_messages。不动 `api.schemas`，对 Supabase 托管 schema 零改动。security-state 表全部留给 Governance 切片。
- profiles：`user_id` 主键（FK auth.users ON DELETE CASCADE）+ display_name（trim 后 1–50 字符、拒纯空白、不唯一）+ 时间戳。**不加 avatar_path 列、不建 avatar bucket**（见"与基线偏差"）。
- organizations 极简：id / name / 时间戳；status 列留给 Governance。
- memberships 不变式：role CHECK（owner/admin/member）、status CHECK（active/ended）；部分唯一索引 `UNIQUE(organization_id, user_id) WHERE status='active'` 与 `UNIQUE(organization_id) WHERE role='owner' AND status='active'`；"恰好一个 Owner"由命令事务保证；结束保留行、重新加入插新行；角色就地 UPDATE；不冗余 ended_by/end_reason。
- invitations：status（pending/accepted/revoked），过期派生自 expires_at（不存 expired 态）；重发保留同行、重置 7 天、新码 supersede 旧码；`UNIQUE(organization_id, email) WHERE status='pending'`；邀请活跃成员邮箱 → 命令拒绝，已结束成员邮箱 → 允许。
- verification_codes expand-only 扩展：+`action_type`、+`target_id`、status CHECK 增加 `'consumed'`、+`failed_attempts` 列（5 次尝试上限由命令层执行）。
- 所有外键与 RLS 查找用列配齐索引（延续基线要求）。

### 写边界、RLS 与 GRANT（ADR-0008）

- 任何需写 Audit Log 或 Outbox 的写操作一律为 Go trusted command；memberships/organizations/invitations/audit_logs 对 client SELECT-only；唯一例外是 profiles（client 可 INSERT/UPDATE 本人行）。该边界由 RLS/GRANT 强制执行。
- 五表全部 ENABLE RLS。授权判断收敛为三个 security definer helper：`is_active_member(org_id)`、`has_org_role(org_id, roles[])`、`shares_active_org(user_id)`——放 identity schema、`search_path=''`、函数体内 `(select auth.uid())`、对 PUBLIC/anon/authenticated 撤销 EXECUTE。
- 策略结构：profiles 本人或活跃同组织成员可见；organizations 活跃成员可见；memberships 本人行（含已结束）+ 本组织活跃行；invitations Owner/Admin 或 `email = jwt email` 的 pending 行；audit_logs Owner/Admin 只读。即时失权由"只读活行"天然满足，不依赖额外失效机制。
- Go 使用单一 `identity_app` LOGIN 角色承载命令、Outbox Worker 与 retention sweep（不拆角色、无 BYPASSRLS）；五张 public 表对 identity_app 加 permissive policy（USING true）。grants：profiles SELECT；organizations/memberships/invitations SELECT,INSERT,UPDATE；audit_logs SELECT,INSERT,DELETE（无 UPDATE）；identity 两表 SELECT,INSERT,UPDATE。organizations/memberships 的 DELETE 留给 Governance。
- 邮箱解析经 `identity.directory (id, email)` security definer 只读视图引用 auth.users，GRANT SELECT 仅 identity_app。

### Audit Log（ADR-0009）

- actor/target 的 user_id 与显示名**写入时快照**，刻意不加 FK（user_id 即 non-login stable identifier）；metadata jsonb；action 为 text，由 Go 单一写入方校验（无 DB CHECK）。
- 不可变性靠 GRANT：client 无写权限，identity_app 无 UPDATE。Go RunWorkers 每日 sweep 删除 365 天前的行。
- 导出 = Desktop 经 RLS 直读分页 + 本地写文件，不建服务端导出接口。

### Go 命令清单、幂等与并发

- 前置切片 1 条：`CreateOrganization`。Membership 切片 8 条：`CreateInvitation` / `ResendInvitation` / `RevokeInvitation` / `AcceptInvitation` / `LeaveOrganization` / `RemoveMember` / `ChangeMemberRole` / `UpdateOrganizationSettings`。
- 幂等主力 = DB 约束 + 状态机 no-op，不建通用幂等表。`CreateOrganization` 由客户端生成 org id 作幂等键：冲突且属同一 User → 返回既有组织。
- 并发控制 = 单事务 `SELECT … FOR UPDATE` 目标行 + 唯一索引兜底，不上 serializable。
- `AcceptInvitation` 单事务五步：验码 → 建 membership → 邀请置 accepted → 写审计行 → 码置 consumed。
- 全部命令归属既有 `internal/identity` Module；JWT/JWKS 验证为 Module 私有（ES256/P-256/kid 缓存）。**JWKS 验证实现属前置切片工作**。

### 传输契约

- 新命令一律 Bearer JWT；`/identity/verification-codes` 保持 `security: []`。
- 防枚举语义：非成员目标 404、角色不足 403 带具体 snake_case 错误码、JWT 失效 401。
- 同步变更返 200 + 受影响资源最小表示；纯入队返 202。错误信封沿用 `{error, message}`。
- Desktop renderer 直连 fetch（不经 IPC 代理）：新增 `VITE_SERVER_URL` 构建期配置（启动校验、缺失即显式失败）；CSP connect-src 按环境加精确 origin；CORS 按环境白名单、无 Origin 放行、永不通配。
- openapi 响应级对照校验升级为测试断言（">1 条受信命令即引入"条件已触发）。

### Outbox 与通知

- 本切片模板 5 个：`invitation`（携码，verification_code_id 关联，重试地平线复用现有机制）、`admin_promoted` / `admin_demoted` / `admin_removed`（各发 affected User + Owner，操作者是 Owner 也发）、`member_removed`（仅被移除者）。每收件人一行。
- 加入、退出、设置变更不发邮件（仅审计行），与基线通知矩阵一致。
- **单封双语**（ZH+EN 同封）：Language Mode 是设备本地，服务端无法知收件人语言。写入时渲染（Go embed 模板），Outbox Worker 保持纯投递器。V1 纯文本。
- 运营可见性维持基线：failed 行保留、failed/cancelled 可区分，无告警与重投工具。

### Desktop 架构与状态模型

- 新建 **Organization Domain**（`features/organization`）：memberships 直读、Active Organization 状态与设备记忆、组织切换、组织 onboarding、成员/邀请管理、组织设置、Organization Audit Log 查看。新建窄 **Profile Domain**（`features/profile`）：全局 Profile 读写与显示名编辑。两词条已入 `apps/desktop/CONTEXT.md`。
- org 状态存 renderer 内存（organization feature model），RLS 直读为唯一来源，无缓存层。remembered active org id 走主进程持久化 + organization domain IPC（循 ADR-0002/0003 先例），不落 localStorage。
- 启动验证：拉 memberships → 记忆有效直接进入 / 0 组织 onboarding / 1 组织自动选中 / N 组织选择界面。onboarding 为第四个顶层视图（路由化，符合 desktop ADR-0004 路由拓扑）。
- 会话中失权为 error-driven：403/404 或直读突变 → 重拉确认 → 退出 org context 并告知；V1 不上 Realtime。
- 邀请自动浮现（RLS email 策略使被邀请人可见 pending 行）+ 点选输码，不做纯手动入口。
- 全部新 Localized Surface 中英双语，过既有 localization 发布检查。
#### Desktop 交互细节（prototype 定稿，2026-08-06）

以下变体裁决与页面归属经用户逐项评判锁定，实现时不得重开；文案以原型 i18n.ts 为基线（全部 Localized Surface 中英双语），字段规则以原型 validation.ts 为基线：

- **页面归属（方向指令）**：成员 / 审计日志 / 个人资料归入设置页；App Shell 侧栏只放软件功能（首页等未来业务 Feature）。设置页从 App Shell 用户菜单「设置」进入，「返回应用」回首页；左导航分两组——**账户**（个人资料、语言）/ **组织**（成员、审计日志，Member 角色不显示审计入口）；侧栏顶部为当前组织上下文卡（组织标 + 组织名 + 角色）。
- **落点**：onboarding 完成、选择组织、接受邀请后 → 首页。
- **Onboarding（B 两步向导）**：第 1 步显示名（trim 后 1–50 字符、拒纯空白），第 2 步组织名（trim 非空）；进度点 + "第 x/2 步"标签；第 2 步可返回上一步；完成即建组织。
- **组织选择（A 居中列表）**：邀请区在组织列表上方；点选邀请浮出 6 位码输入（5 次尝试上限）；含"创建组织"入口进 onboarding。
- **成员与邀请管理（B 标签页）**：两个标签页——成员 / 待定邀请（带计数徽标）；邀请创建/重发/撤销走对话框；角色变更用 Select；移除成员与退出组织均需确认对话框；Member 角色只读、无邀请按钮；成员行只显示显示名与角色（Profile 不含邮箱，RLS 下他人邮箱不可见）。
- **审计日志（B 时间线）**：按天分组叙事时间线（"林晓 移除成员 → 李其 · 11:48"式行，与 ADR-0009 写入时快照模型一致）；动作过滤 Select；CSV 导出按钮 + 导出反馈（对应 Desktop 本地写文件）。
- **个人资料（A 设置页区块）**：头像占位 + 显示名字段 + 保存/取消（脏检查）+ 已保存反馈。
- **失权告知（A 阻断对话框）**：会话中失权 → 阻断式对话框（标题含失去的组织名 + 说明 + "知道了"）；确认时组织已从列表移除；落点：仍有余组织 → 选择界面，无组织 → onboarding。
- **共享原语例外登记**：`dialog`、`tabs`、`badge` 三个 shadcn 原语加入 `components/ui/`（用户已裁决登记）；实现 ticket 须显式声明该例外并接受附加审查。

### 前置切片 mini-spec（Identity Foundation 收尾）

- **范围**：profiles 读写与显示名编辑（Profile Domain）；CreateOrganization 命令 + 组织 onboarding 视图；Active Organization 状态、设备记忆与启动验证三分支；Go 私有 JWKS 验证；`VITE_SERVER_URL` 与直连 fetch 通道。
- **Migration**：profiles/organizations/memberships 三表 + RLS 策略 + GRANT + 三个 helper + identity_app 角色 + identity.directory 视图。
- **明确不含**：invitations/audit_logs/verification_codes 扩展、成员与邀请管理界面、审计界面、Outbox 模板（均归 Membership 切片）。
- **验收门禁**：migration 过 advisors；RLS 集成测试（真实 anon/authenticated token）证跨组织隔离与 own-profile 写限制；Go 侧 JWKS 验证 + CreateOrganization 集成测试（含客户端 id 幂等、org + 首任 Owner 原子性）+ openapi 对照校验断言；Desktop e2e：onboarding（注册 → display name → 建组织 → App Shell）、重启后 active org 记忆恢复、启动验证三分支；全部新 Localized Surface 双语过发布检查。

### 与基线偏差

- **avatar 上传本阶段不做**：基线 spec 写"Profile 含可选头像"，本切片统一使用默认头像（renderer 资源），不加 avatar_path 列、不建 bucket。未来以 expand-only 方式补齐（加列 + Storage policy）。此偏差已在本 spec 记录，实现时不得"顺手"加回头像上传。

### Known gaps 关闭声明

对照 identity-v1 基线的 Known gaps：

- schema 不变式、RLS/GRANT 矩阵、受信命令接口（请求/结果/错误/幂等/并发）、Outbox 模板清单、Desktop 状态模型骨架、切片验收/回滚/附加审查门禁、ADR 集合 —— **由本会话关闭**（本文与 ADR-0008/0009）。
- 密码策略与 CI harness 基线 —— 由阶段 1 关闭（ticket 03/09），本 spec 引述确认。
- User Deletion 撤销语义 —— 归 Governance 切片，不在本 spec。
- Desktop 具体 UI 行为 —— **已关闭**（prototype 6/6 变体裁决与页面归属指令已回填，见 Desktop 架构与状态模型节）。

## Testing Decisions

好测试的标准：只跨接缝测外部可观察行为（HTTP 响应、Data API 读写结果、审计行/Outbox 行内容、界面可见行为），不测私有实现细节；每个门禁断言对应一条用户故事或不变式。

五条接缝（全部复用阶段 1 既有 harness，不为本切片新建测试框架）：

1. **Migration 接缝**：声明式 schemas + 生成 migration，过 advisors 与 migration-history 检查。Membership 切片另含 invitations/audit_logs/verification_codes 扩展 migration。
2. **RLS/Data API 接缝**：真实 anon/authenticated token 直连 PostgREST。前置切片证跨组织隔离与 own-profile 写限制；Membership 切片证被邀请人可见性、Member 读不到 audit_logs、Membership 终止后即时失权。
3. **Go 命令 HTTP 接缝**：跨 `internal/identity` 外部 interface + 真实 DB。前置切片：JWKS 验证、CreateOrganization（幂等、原子性）；Membership 切片：8 条命令集成测试、审计行与通知矩阵逐事件核对、邀请并发接受竞态、携码邮件重试地平线。
4. **Desktop Playwright e2e 接缝**：前置切片：onboarding、重启记忆恢复、启动三分支；Membership 切片：多组织切换、成员/邀请管理、接受邀请流、审计查看/导出、失权退出。新用例归入既有 tier（ADR-0007：PR 跑 Smoke Suite、main 跑 Full E2E Suite）。
5. **openapi 契约接缝**：响应级对照校验为测试断言。

Prior art：阶段 1 Auth Harness（临时 Supabase 栈 + Mailpit）、mail-smoke-ci、desktop e2e 分层门禁、RLS 真实 token 测试、packaged localization 发布检查。

## Out of Scope

- Governance 切片全部内容：Ownership Transfer、Organization/User Deletion、Email Change、Security Lock、security-state 表、organizations/memberships 的 DELETE。
- avatar 上传与 Storage policy（见偏差节）。
- Realtime 推送式失权（V1 用 error-driven 检测）。
- ex-member Profile 可见性收窄（推迟到业务 Feature 需要时）。
- 自定义角色、细粒度权限、Suspended Membership、SSO/SCIM/MFA 等基线已排除项。
- 超出 failed 行保留的可观测性与支持工具。
- 阿里云 RDS 供给与迁移。

## Further Notes

- 顺序状态：prototype 已完成并回填本 spec（2026-08-06：6/6 变体裁决 + 页面归属指令 + dialog/tabs/badge 原语例外）；下一步 `/to-tickets` 出 tracer-bullet tickets（标前置切片 blocking 边）。原型目录（`.scratch/identity-org-membership/prototype/`）与 runner 痕迹（`vite.prototype.config.ts`、`package.json` 的 `prototype` 脚本）在 spec 定稿后按仓库规则清理：`.scratch/` 直提 main，`apps/desktop/` 走 feature branch + PR。
- ADR-0008 / ADR-0009 已落盘 `docs/adr/`；Desktop 双新域不独立立 ADR（词条在 `apps/desktop/CONTEXT.md`，Feature 内部责任受控演化）。
- `apps/desktop/CONTEXT.md` 的两个新词条（Organization Domain、Profile Domain）已随 1f045e2 提交。页面归属指令使 Settings Page 词条（"承载设备级设置项（当前仅有 Language Mode）"）过时——设置页现承载账户（个人资料、语言）与组织（成员、审计日志）两组导航，词条措辞更新随原型清理分支一并走 feature branch + PR。
- 实施前请重读根 `AGENTS.md` 的目录架构门禁与高风险变更流程（本切片涉及 migration 与公共契约，须走 feature branch + PR）。
