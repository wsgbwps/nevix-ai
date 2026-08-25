# Session 签发与校验核心（#140）实施计划

Issue: https://github.com/wsgbwps/nevix-ai/issues/140 （spec: #138）
Branch: `identity-session-cutover`（Tickets 2–6 共同 integration branch；不独立合入 main）
Fixed point: `main` @ `e9be889`（#139/#146 已合入，Write Transaction scope + AfterCommit 就绪）

## Acceptance boundary

#140 的 16 条验收项（issue 原文），交付物 = Server Identity 内部 concrete Session
责任模块 + Login 作为第一个端到端 tracer + 授权 principal 收敛到非敏感 Session
identity。HTTP/OpenAPI shape 与数据库 schema 不变。旧 auth 内 session 辅助函数被
迁移替换（不保留双实现）；register/setup 的内联 session SQL 留给 #142，本票仅让
其复用 session 包的 token 生成与 TTL 常量（消除重复定义）。

## Primary Domain 与 task-owned paths

- Primary Domain: **Server Identity Module**（server/CONTEXT.md）
- 新建 owner: `server/internal/identity/session/`——Session 责任模块（非顶层
  Server Module、非共享数据库层；Module 内 sub-package，同 auth/users/writetx 级别）
- 相邻 seam（最小触碰）:
  - `server/internal/identity/auth/sessions.go`、`commands.go`、`account.go`、
    `register.go`、`setup.go`——Login tracer、Authenticate adapter、吊销/改密改用
    session id、register/setup 复用 NewToken/TTL
  - `server/internal/authz/authz.go`——**共享区**：`Principal.SessionTokenHash []byte`
    → `Principal.SessionID string`（sessions.id，非敏感）
  - `server/internal/identity/module.go`——仅 doc comment 更新（session 包归属描述）
- 测试: `server/internal/identity/session/session_integration_test.go`（包内真实
  PostgreSQL，吸收并替换 auth/sessions_integration_test.go 的 race 测试）、
  `server/internal/identity/integrationtest/login_session_test.go`（新增
  Last Login At 合同测试）、`scripts/test-identity-integration.sh`（sentinel 更新）

## 设计决定（对齐 #138 Implementation Decisions）

1. `session.Store{db, runner}` concrete 实现，四个概念入口中的三个：
   `Issue(ctx, sc, input)`、`Validate(ctx, token)`、token 生成（`NewToken`）；
   refresh 是 Validate 内部的 best-effort 步骤。不引入 Go interface/mock。
2. `Issue` 参与调用方事务：签名收 `*writetx.Scope`，只经 `sc.Tx()` 执行 SQL；
   不 begin/commit/rollback。锁点重验：`SELECT ... FOR UPDATE` 后比对
   `status='active'` 与 `password_hash == CredentialStamp`；不等则
   `ErrInactiveUser` / `ErrStaleCredential`。INSERT session + `last_login_at=now()`
   同一事务。**不写任何 Audit Log**（调用方 Login 写 `session_created`）。
3. `Issue` 返回 `IssuedSession{Token, ExpiresAt}`——仅 opaque token 与 expiry。
4. `Validate` 统一 hash、lookup、expiry、active 检查、refresh threshold；
   unknown/expired/revoked/disabled 统一 `ErrInvalid`；基础设施错误保持 wrapped
   可区分（fail closed）。剩余寿命 < threshold 时经 runner 刷新（best-effort，
   失败仅 slog），不推进 `last_login_at`。
5. `auth.Service.Authenticate` 保留 Bearer 解析，委托 `Validate`，映射
   `ErrInvalid → authz.ErrNotAuthenticated`，其余 wrap 为基础设施错误。
   `authz.Principal.SessionID` 来自 `sessions.id`。
6. `revokeSession`（Logout）与 `ChangePassword` 的 current-session 定位从
   `token_hash = $1` 改为 `id = $1`（/`id <> $2`）——同一行的等价键迁移，
   语义不变；完整吊销核心归 #141/#143。
7. 错误映射：Login 将 `ErrInactiveUser → errAccountDisabled`、
   `ErrStaleCredential → errInvalidCredentials`（与现行行为一致）。

## 测试计划

- 包内真实 PG（session 包，opt-in 契约与 auth/writetx 相同）:
  issuance+stamp 原子性、lock 重验 race（迁移自 auth race 测试）、
  caller 回滚联动、Validate 身份/事实、sliding refresh、expired/revoked/disabled
  统一 ErrInvalid、Issue 不写 audit。
- 合同层（integrationtest）: 现有 Login/token-hash/audit/sliding/expiry/restart
  测试保持；新增 Login 推进 `last_login_at` 且 refresh 不推进。
- `go build ./... && go vet ./... && go test ./...`；真实库套件经
  `./scripts/test-identity-integration.sh`（CI 同入口）。

## 风险与回滚

认证安全边界变更：principal 字段替换触碰共享区 authz（影响面=Logout/改密的
current 定位键，均有测试）；register/setup 仅换 token 生成调用点。分支可整体
revert。QA 逐项证据回填 issue #140。
