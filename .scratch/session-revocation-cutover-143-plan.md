# 密码变更、Admin reset 与 disable 切换到 Session 吊销（#143）实施计划

Issue: https://github.com/wsgbwps/nevix-ai/issues/143 （spec: #138）
Branch: `identity-session-revocation-cutover`（自 `identity-session-cutover` 开出；Tickets 2–6 共同 integration branch，未获 #144 最终验收不得合入 main）
Fixed point: `e332c9b`（#141 交付：Session current/others/all 吊销核心 + Logout tracer）

## Acceptance boundary

#143 的 14 条验收项。交付物 = 自助改密、Admin password reset、User disable 三条
调用路径的内联 session 删除 SQL 全部切换到 `session.Revoke`（others / all /
all），调用方继续拥有授权、User/credential mutation、业务锁、命令错误与
Audit Log action。HTTP/OpenAPI shape 与数据库 schema 不变；sweep 与旧实现
删除留给 #144。

## Primary Domain 与 task-owned paths

- Primary Domain: **Server Identity Module**（server/CONTEXT.md）
- 现有 owner: `server/internal/identity/session/`（#140/#141 已就位的
  Revoke/RevocationTarget，本票零改动）
- 调用方切换（最小触碰）:
  - `server/internal/identity/auth/account.go`——ChangePassword：锁内重读
    status、`session.Others` + `Revoke` 替换内联 DELETE
  - `server/internal/identity/users/governance.go`——Disable/ResetPassword：
    `session.All` + `Revoke` 替换 `revokeAllSessions`（该 helper 删除）
  - `server/internal/identity/users/users.go`——Service 增挂 `sessions`
  - `server/internal/identity/module.go`——构造点传参
- 测试: `server/internal/identity/integrationtest/session_revocation_cutover_test.go`
  （新增合同测试）、`scripts/test-identity-integration.sh`（sentinel 更新）

## 设计决定（对齐 #138 Implementation Decisions 与 #141 已建核心）

1. **改密 = others**：`session.Others(principal.UserID, principal.SessionID)`
   在事务外构造（与 Logout 的 Current 同一 seam：principal 缺 identity 是
   wiring bug，构造 refusal 直接 500 面）；`Revoke` 在命令的
   `runner.Run` 回调内执行，与其他 mutation 同事务提交/回滚。`changed` 不
   分支——改密命令的 audit 语义由命令自定（只写一次 `password_changed`）。
2. **reset/disable = all**：`session.All(user.ID)` 在回调内构造（user.ID 来自
   锁内加载的行，refusal 不可达但诚实传播）；同一事务内执行 `Revoke`。
   `revokeAllSessions` 内联 SQL 删除，不留 fallback/双实现。
3. **改密的锁内 active 重检**：`SELECT ... FOR UPDATE` 增加 status 列；非
   active（disable 先提交）返回 `errInvalidCredentials`——endpoint 合同只
   文档化 200/400/401/500，且 spec 要求对外行为不变；这与 Login 把 issuance
   锁点的 stale credential 折叠进 invalid_credentials 的先例一致（该账号的
   下一个请求本来就会在 guard 得到 401）。重检在任何写入之前，回滚零残留。
4. **post-commit effect**：三条路径的精确受影响 session identities 由
   `Revoke` 内部经 `sc.AfterCommit` 登记（#141 已就位）；回滚或 commit
   failure 不产生可观察断流——writetx 生命周期测试 + 包内回滚测试持有。
5. **命令所有权不变**：authorization guard、last-active-admin 保护、
   credential mutation、HTTP error mapping（MapError 零改动）、audit
   actor/target/metadata 均留在命令层。

## 测试计划（新增合同测试，全部过 assertContractResponse）

- audit 最小事实 ×3：改密 delta 恰一条 `password_changed`、disable 恰一条
  `user_disabled`、reset 恰一条 `user_password_reset`（无 session_revoked）；
  同时断言 others/all 的提交后认证失败（401）与终态 session 数。
- commit-order race 双向：
  - `TestDisableCommittedBeforeWaitingPasswordChangeFailsIt`——blocker 持
    member 行 FOR UPDATE，改密在锁上等待；blocker 提交 disable 后改密得 401
    invalid_credentials，hash/status/flag/session 数/audit 零变化。
  - `TestDisableAfterCommittedPasswordChangeRevokesEverySession`——改密先
    提交（当前会话存活），后续 disable 用 all 连当前会话一并吊销。
- 回滚 ×3：`failAuditWritesFor` 在命令最后一个参与者（audit 写入）注错 →
  500；断言 mutation+revocation+audit 一体回滚（sessions 存活、旧密码可登
  录、无 audit 行）；修复后同命令成功（证明回滚而非半途状态）。
- 检查: `go build ./... && go vet ./... && gofmt -l`；`go test -race ./...`；
  `./scripts/test-identity-integration.sh`（零 skip，8 个新 sentinel 入清单）。

## 风险与回滚

认证安全边界变更。风险集中在：改密并发序列化回归（既有
`TestChangePasswordSerializesConcurrentChanges` 继续 hold）、race 测试的
choreography 稳定性（1500ms 等待 + 30s 超时，复用 register 锁测试模式）、
错误码映射外溢（401 折叠有注释与测试钉住）。分支整体可 revert；QA 逐项
证据回填 issue #143。
