# Session current/others/all 吊销核心：Logout tracer（#141）实施计划

Issue: https://github.com/wsgbwps/nevix-ai/issues/141 （spec: #138）
Branch: `identity-session-cutover`（Tickets 2–6 共同 integration branch；本票及后续票未获 #144 最终验收不得合入 main）
Fixed point: `4e378c3`（#140 交付：session 签发/校验核心 + Login tracer + Principal.SessionID）

## Acceptance boundary

#141 的 13 条验收项。交付物 = Session 责任模块内统一的 `current`/`others`/`all`
吊销能力 + Logout 作为第一个端到端 tracer。HTTP/OpenAPI shape 与数据库 schema
不变；Session 只改变 durable session state、判断是否实际变化、内部保留精确受
影响 session identities 并经 Write Transaction scope 登记提交后连接 effect；
调用方继续拥有命令规则与 Audit Log 语义。disable/reset/改密的内联吊销 SQL 留
给 #143，sweep 留给 #144。

## Primary Domain 与 task-owned paths

- Primary Domain: **Server Identity Module**（server/CONTEXT.md）
- 现有 owner: `server/internal/identity/session/`——吊销核心落在此包
- 相邻 seam（最小触碰）:
  - `server/internal/identity/auth/sessions.go`——删除 `revokeSession`；类型
    引用随命名收敛更新
  - `server/internal/identity/auth/commands.go`——Logout tracer 切换到
    `session.Revoke(current)`，changed 时写一次 `session_revoked`
  - `server/internal/identity/module.go`、`mount_test.go`——构造点随命名更新
- 测试: `server/internal/identity/session/session_integration_test.go`（包内
  真实 PostgreSQL 吊销测试）、
  `server/internal/identity/integrationtest/login_session_test.go`（Logout
  合同面补强）、`scripts/test-identity-integration.sh`（sentinel 更新）
- #140 评审 deferred advisory 落地（同包重命名，无行为变化）:
  - `session.Store`/`NewStore` → `session.Service`/`NewService`（CONTEXT.md
    Repository avoid-list 含 "store"；与 auth/users/joincodes 的 Service 命名
    一致）
  - `session.Identity` → `session.ValidatedSession`（避免与保留词
    "Authentication Identity"（session_user）冲突）

## 设计决定（对齐 #138 Implementation Decisions）

1. **closed representation**：`RevocationTarget` 为带 unexported marker method
   的封闭接口，仅有三个 unexported 变体 + 三个构造器 `Current(sessionID)`、
   `Others(userID, exceptSessionID)`、`All(userID)`。enum + optional field 的
   非法组合（如带例外的 all、无 session 的 current）不可表示；未来 License 的
   global 目标按 #49 以第四变体扩展。
2. **Revoke 参与调用方事务**：`Revoke(ctx, sc *writetx.Scope, target)
   (changed bool, err error)`——只经 `sc.Tx()` 执行
   `DELETE ... RETURNING id`；不 begin/commit/rollback。caller-visible 结果只有
   `changed`（durable state 是否变化）；精确删除的 session identities 是包内
   实现事实。
3. **no-op 语义**：`RETURNING` 为空 → `changed=false`，不登记 effect、不写
   audit（audit 本就 caller-owned）；nil/未知 target 变体报错而非静默。
4. **post-commit connection effect**：命中行按 id 排序后经
   `sc.AfterCommit` 登记一次性 effect，携带精确受影响 identities。Write
   Transaction scope 已保证 effect 仅在成功 commit 后执行（rollback/取消/
   panic/commit failure 均不执行，#139 已有 7 个 writetx 生命周期测试）。
   生产路径 effect 记录已提交的精确集合（slog.Info）；**不为尚不存在的物理
   SSE hub 预造 transport adapter、跨 Module event contract 或假想 production
   port**——包内测试经 unexported seam 固定精确集合与提交后时序（effect 内
   直查库断言行已消失，证明 commit-before-effect）。
5. **Logout tracer**：`Logout` 在自身 `runner.Run` 回调内调
   `session.Current(principal.SessionID)` 吊销；`changed=true` 时快照 Actor 并
   写一次 `session_revoked`；no-op 不写。HTTP 行为不变（no-op 经 HTTP 不可达
   ——guard 先拒已吊销 token，合同已覆盖 401 路径）。
6. **并发**：DELETE 的行级锁定天然串行化吊销与签发/改密/停用；无需前置
   `FOR UPDATE`（Issue 的锁点重验是签发语义，吊销无状态重验需求）。

## 测试计划

- 包内真实 PG（session 包）:
  - 三种 disposition 精确集合：others 删 B/C 留 A、current 只删 A、all 全删；
    changed/no-op 分支；不写 audit；effect 收到精确排序集合。
  - no-op：不存在的 current/others/all → `changed=false`、零 effect、零 audit。
  - 事务参与：callback error 与 panic 两条路径回滚后行仍在、effect 未执行；
    回滚前 `changed=true`（事务内已删）。
  - effect 时序：effect 执行时直查库断言受影响行已不可见（commit 先于
    effect）。
- 合同层（integrationtest）: 既有 `TestLogoutRevokesOnlyTheCallingSession`
  继续全绿（多设备、audit 一次 `session_revoked`、后续认证 401、repeat 401）；
  新增双设备顺序 Logout 合同测试（各自只吊销本设备、audit 两条 revoked、终态
  空表）。
- 检查: `go build ./... && go vet ./... && go test -race ./...`；
  `./scripts/test-identity-integration.sh`（零 skip，新 sentinel 入清单）。

## 风险与回滚

认证安全边界变更。风险集中在：Logout 语义回归（合同测试覆盖）、effect 时序
（writetx 已测生命周期 + 包内时序断言）、重命名波及面（编译器全量校验，五个
文件）。`others`/`all` 本票尚无生产调用方（#143 切换），由包内测试覆盖。分支
整体可 revert；QA 逐项证据回填 issue #141。
