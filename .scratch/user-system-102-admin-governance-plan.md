# Issue #102 — Admin 用户管理与审计读取：实施计划

高风险变更（授权面 + 公共契约 + 持久化迁移），按 AGENTS.md 要求先写计划。
Fixed point：`main` @ e51ea59。父 spec #99；依据 ADR-0014（Go 唯一数据面）、
ADR-0015（单租户用户系统与 Go 层授权）、ADR-0009 修订版（审计快照/不可变）。

## 范围边界

- 只做 #102：Admin 治理动作（建号/停用/重置密码/改 email/调角色/删除）、
  用户目录与管理列表、审计分页读取（admin-only）、末位 admin 保护。
- 不做 #101 的自助面：首登强制改密门禁、自助改密、自助改显示名。
- 不做 SSE、桌面端、导出（#105/#106 等后续票）。

## 端点设计（全部进 OpenAPI 契约，Seam A 集成测试逐条对照）

| 端点 | Guard | 语义 |
|---|---|---|
| POST /identity/users | Admin | 建号 + 初始密码（must_change_password=true），审计 user_created |
| GET /identity/users | ActiveUser | 团队目录：仅活跃用户，id/email/display_name；分页+搜索 |
| GET /identity/admin/users | Admin | 管理列表：全部用户全字段（role/status/must_change_password/last_login_at/created_at）；分页+搜索 |
| POST /identity/users/{id}/disable | Admin | 停用 + 同事务吊销全部会话，审计 user_disabled |
| POST /identity/users/{id}/reset-password | Admin | 重置初始密码 + must_change_password=true + 吊销全部会话，审计 user_password_reset |
| POST /identity/users/{id}/email | Admin | 改登录 email，审计 user_email_changed（metadata from/to） |
| POST /identity/users/{id}/role | Admin | member↔admin，审计 user_role_changed（metadata from/to） |
| DELETE /identity/users/{id} | Admin | 仅从未登录（last_login_at IS NULL）；审计 user_deleted（metadata email） |
| GET /identity/audit-logs | Admin | 分页 newest-first；member 被 RequireAdmin 拒 403 |

## 关键决策

1. **「从未登录」判定**：新 migration `0002` 给 `users` 加可空 `last_login_at`，
   登录事务内随会话签发一并写入。审计行有 365 天保留期、会话可被吊销，
   二者都不能作为「从未登录」依据；列是唯一可靠不变量。
2. **末位活跃 admin 保护**：降级/停用活跃 admin 前，在同一写事务内
   `SELECT count(*) ... WHERE role='admin' AND status='active' AND id <> $1 FOR UPDATE`
   计数为 0 则拒 409 last_admin_protected。READ COMMITTED 下 EPQ 重评估 +
   行锁串行化保证并发下不变量（最坏情况是一次死锁 500，可重试，不变量不破）。
   删除不可能触达该不变量：删除者自身是活跃 admin 且已登录，目标若是删除者
   本人则因「已登录」先被拒。
3. **包结构**：新 `internal/identity/users/`（目录 + 治理命令，责任命名子包）；
   `audit/` 增读取 Service 与新动作词汇；`auth/` 导出 HashPassword/NormalizeEmail
   （密码与 email 规范单一落点）并把快照查询上移为 `audit.SnapshotSubject`。
4. **分页/搜索**：`command` 骨架包提供统一 ParsePagination/ParseSearch
   （page≥1 默认 1；per_page 1..100 默认 20；q ≤256），违规 400
   invalid_pagination / invalid_search。目录与管理列表同参数契约。
5. **email 冲突**：依赖 users_email_key 唯一约束，23505 → 409 email_taken。
6. **幂等语义**：停用已停用账号 = 200 no-op（无审计行，镜像 logout 语义）；
   其余治理动作均为显式动作，始终写审计行。

## 测试计划（Seam A：Module 公开契约 → HTTP → 真 PG）

- `admin_governance_test.go`：建号（含 403/400/409 分支）、停用（存量会话即刻
  401、幂等、末位 admin 自停/被他停 409）、删除（从未登录放行、已登录 409、
  404）、重置密码（旧会话失效、新密码可登录）、改 email（新旧登录消长、409）、
  调角色（member↔admin 权限消长、末位 409）、失败操作不落审计行。
- `directory_and_audit_test.go`：目录可见性（member 只见活跃用户三字段、
  disabled 隐身）、搜索（email/display_name ILIKE + 转义）、分页 total、
  管理列表（admin 全字段、member 403 forbidden）、审计分页 newest-first、
  member 403、条目快照字段。
- 每个断言响应过 `assertContractResponse` 契约对照。
- `mount_test.go` 扩展新路由的 guard/preflight 枚举。

## 验收对照（#102 逐条）

1. 建号带 must_change_password → governance 测试 ✓
2. 停用吊销全部会话且即刻失效 → disable 测试（旧 token 401）✓
3. 删除仅限从未登录 → delete 测试 ✓（last_login_at）
4. 重置密码吊销全部会话 → reset 测试 ✓
5. 改 email 仅 Admin → guard 测试（member 403）✓
6. 角色调整双向 → role 测试 ✓
7. 末位活跃 admin 保护（降级+停用）→ last-admin 测试 ✓
8. 分页+搜索目录全员互见 → directory 测试 ✓
9. 治理写同事务落审计 → 审计行断言 + 失败路径无审计行 ✓
10. 审计分页 admin-only → 403/分页测试 ✓
11. Seam A 集成测试全覆盖 → 本计划测试族 ✓
