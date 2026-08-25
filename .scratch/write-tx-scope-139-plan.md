# Issue #139 — Identity Write Transaction：scope 与 AfterCommit：实施计划

高风险变更（认证/安全边界 seam），按 AGENTS.md 要求先写本计划。
Fixed point：`main` @ 0164a1f。Spec：#138（Server Identity Session 深化，父 spec）；本票 #139 是
Session 原子 cutover 前的独立 prefactor，可单独一个 PR 合入 main。
依据 ADR-0014（Go sole trusted data plane）、ADR-0015（single-tenant user system 与 Go authorization）。
本切片不改变任何责任 seam（writetx 仍是 Identity 内部 Write Transaction Module）、不改数据库 schema、
不改 HTTP/OpenAPI 行为。评审（CR-STANDARDS-0001，已接受）：AfterCommit 提交后编排是对 trusted-execution seam 的新架构承诺，
按 AGENTS.md 的 ADR 门以 2026-08-25 修订条目补入 ADR-0015「写事务纪律」（本 PR 内完成）。
评审台账：`.scratch/write-tx-scope-139-review-ledger.json`。

## Acceptance boundary

- 验收标准 = #139 的 9 项 acceptance criteria（见下方 QA 对照）。
- 用户可见行为零变化：所有 Identity 命令的成功/失败/审计/并发语义保持不变。
- 本票不包含 Session ownership 切换（那是后续票）；只为它铺平提交后 effect 的安全编排 seam。

## Primary Domain 与任务自有路径

- Primary Domain：Server Identity（`server/internal/identity/`）。
- 最窄新 owner：`server/internal/identity/writetx/`（scope 类型 + after-commit 生命周期）。
- 原子迁移的调用方（同一 release 状态，无双实现/兼容 adapter/feature flag）：
  - `writetx/writetx.go`（含 `VerifyStartupIdentity`）
  - `auth/sessions.go`（refreshSession、issueSession、revokeSession、sweepOnce，4 处）
  - `auth/account.go`（ChangePassword、UpdateMe，2 处）
  - `auth/register.go`（Register，1 处）
  - `auth/setup.go`（Initialize，1 处）
  - `users/governance.go`（Create、Disable、ResetPassword、ChangeEmail、ChangeRole、Delete，6 处）
  - `joincodes/lifecycle.go`（Create、Revoke，2 处）
- 测试：`writetx/writetx_test.go`（单元：成功与全部失败路径的 effect 语义）、
  `writetx/runner_roles_integration_test.go`（真实 PostgreSQL：迁移回调签名 + after-commit 成功/失败路径）、
  既有 `auth/sessions_integration_test.go` 不需要改（它不触碰回调签名，只构造 Runner）。

## 接口设计（narrow scope）

```go
// Run 新回调签名（旧 func(pgx.Tx) error 原子替换，不留双入口）：
func (r *Runner) Run(ctx context.Context, fn func(*Scope) error) error

type Scope struct{ /* tx + 注册的 effects，均不导出 */ }
func (s *Scope) Tx() pgx.Tx              // 当前写事务；回调只经 scope 取得
func (s *Scope) AfterCommit(effect func()) // 登记提交后 effect（闭包自带所需上下文）
```

AfterCommit 生命周期契约（文档化 + 行为测试）：

1. effect 仅在事务成功 commit 之后执行一次，按登记顺序（FIFO）在调用方 goroutine 上同步运行。
2. 以下任一情况，所有 effect 均不执行：begin 失败、execution-identity 验证失败、回调返回错误、
   取消阻止提交（commit 前 ctx.Err()）、回调 panic、rollback、commit 失败。
3. effect 运行时事务已提交：effect 失败不改变已提交结果，也不回滚任何东西；effect panic 按编程
   错误原样传播，其后的 effect 不再运行（契约明示，不靠实现细节）。
4. Write Transaction Module 仍是唯一 owner：Session 或其他调用方拿不到 begin/commit/rollback/重试/
   嵌套事务的入口；scope 只暴露读事务与登记 effect 两个能力。
5. 构造期与事务期 execution-identity 验证、取消语义、panic 语义、"不自动重放回调" 全部保持不变
   （既有测试不改动断言，仅迁移签名）。

调用方迁移为机械替换：`func(tx pgx.Tx) error` → `func(sc *writetx.Scope) error`，回调体首行
`tx := sc.Tx()` 后保持原 body；辅助函数（`audit.Write`、`loadUserForUpdate` 等）继续收 `pgx.Tx`，
它们在回调 seam 之下，不属于本次迁移面。

## 测试计划（TDD，pre-agreed seam = Run 的 scope 回调）

- 单元（writetx_test.go，narrow double）：effect 在 commit 后恰好各执行一次、按登记顺序；
  回调错误/取消/panic/identity 拒绝/commit 失败/begin 失败下零执行；effect panic 传播且后续
  effect 不运行、已提交状态不受影响；既有 identity/cancel/panic/no-replay 断言原样保留。
- 真实 PostgreSQL（runner_roles_integration_test.go）：成功路径上 effect 在 commit 后可见已提交
  数据；回调错误 rollback 后数据缺席且 effect 零执行；回调内取消阻止提交且 effect 零执行；
  panic → rollback + 零 effect；既有三条角色证据测试迁移签名。commit/rollback 故障注入保持由
  单元 double 证明（真实 PG 无法确定性表达）。
- 既有 Identity 套件（含 integrationtest 与 auth/users 包内测试）全部保持通过。

## QA 对照（#139 验收标准）

1. 写事务回调只通过 narrow scope 访问当前事务和登记 AfterCommit effect —— 迁移后 grep 无
   `func(tx pgx.Tx) error` 形态的 Run 回调。
2. writetx 唯一 owner：scope 仅 `Tx()` + `AfterCommit`；无任何 begin/commit/rollback/retry 出口。
3. AfterCommit 仅成功 commit 后各执行一次 —— 单元 + 真实 PG 测试。
4. 回调错误/取消阻止提交/panic/rollback/commit failure 下零执行 —— 单元 + 真实 PG 测试。
5. 多 effect 执行约定明确（FIFO、同步、恰好一次）且有行为测试。
6. 所有现有 Identity 写调用方原子迁移，无旧签名/兼容 adapter/双入口 —— grep + 编译。
7. execution-identity 验证、取消、panic、不自动重放语义不变 —— 既有测试断言未动、全部通过。
8. 单元 + 真实 PG 集成测试覆盖成功与全部失败路径（故障注入路径按既有分工由 double 承担）。
9. 既有 Identity 测试保持通过；不含 Session ownership 切换 —— diff 范围核对。
