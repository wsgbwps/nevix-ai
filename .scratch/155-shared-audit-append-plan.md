# Plan: 共享化事务内 Audit Append（issue #155，spec #150 切片 5）

## Boundary declaration

- **Acceptance boundary:** issue #155 的 8 条验收标准，权威语义来自 ADR-0009
  （2026-08-26 修订）与 ADR-0016「共享 Audit Append」节；不重开任何已关闭决策。
- **Fixed point:** `main` @ `744a5b9`（分支创建时 HEAD）。
- **Primary Domain:** Server Shared Audit。最窄 owning boundary：
  - 新共享子包 `server/internal/auditlog/`（append seam、action 词汇、subject 快照）；
  - Identity 保留 `server/internal/identity/audit/read.go`（Admin 查询/分页 owner）。
- **Task-owned paths:**
  - 新增：`server/internal/auditlog/log.go`、`server/internal/auditlog/append_integration_test.go`、本计划文件。
  - 修改：`server/internal/identity/audit/`（删除 `log.go`，`read.go` 包注释收窄）、
    `auth/account.go`、`auth/commands.go`、`auth/register.go`、`auth/setup.go`、
    `joincodes/lifecycle.go`、`users/governance.go`（import 切换）、
    `scripts/test-identity-integration.sh`（纳入 auditlog 树 + sentinels）。

## Assumptions（显式假设）

1. `Write` 更名为 `Append`：ADR/规格/ticket 一致使用 "Audit Append" 词汇；行为不变。
2. Action 词汇整体随 seam 迁入共享包（ADR-0009「action 由 Go 单一写入方校验」——单一写入方
   即共享模块）；Creation 后续切片在同一词汇表追加，无需 migration。
3. `SnapshotSubject` 随 seam 迁入：审计 actor「只表示真实 User」由从单租户 user registry
   读写时快照保证（ADR-0009）；否则 Creation 仍需 import Identity implementation。
4. 365 天 retention sweep 留在 Identity（`auth/sessions.go`）：本切片只提升 append seam；
   sweep 是整表 DELETE，与写入方无关；AC 只要求「保留期维持 365 天」不变。
5. 共享包是库式深模块（同 `internal/event`/`internal/authz` 先例），无 LoadConfig/
   Register/RunWorkers 生命周期——它不拥有事务，无需 worker。
6. metadata 脱敏纪律归调用方（规格：Creation append「脱敏 metadata」）；共享包只收
   `map[string]string` 并编码，不做内容过滤。
7. 无 schema/migration/OpenAPI 变化：表、grants、HTTP contract 全部不动。

## Design

- `auditlog.Append(ctx, tx pgx.Tx, entry Entry) error`：校验 action ∈ 词汇表 →
  编码 metadata → INSERT `public.audit_logs`（SQL 与现 `audit.Write` 逐字相同）。
  失败返回 error，由调用方事务回滚；不 begin/commit/rollback。
- `auditlog.SnapshotSubject(ctx, tx, userID)`：SQL 不变。
- Identity 6 个写路径调用点机械切换 import；`routes.go`/`read.go` 不动。
- 新真库测试（包内 `*_integration_test.go`，env 门控同 writetx）：
  1. append 失败（owner 撤 INSERT grant）→ 调用方业务写回滚；
  2. 非法 action 拒绝且不落行；
  3. 调用方回滚 → audit 行不可见；
  4. commit → 业务事实与 audit 行同时可见（commit 前另一连接两者皆不可见）；
  5. 并发 append 各自事务全部落行、actor 正确。

## Verification（已执行结果）

- `cd server && go vet ./...` — PASS；`gofmt -l .` 无输出。
- `cd server && go test ./...` — PASS（无环境时 integration skip，符合门控契约）。
- `./scripts/test-identity-integration.sh` — PASS：175 个顶层集成测试全部通过、零 skip、零 FAIL；
  含 identity 契约面（TestAuditListIsAdminOnlyAndNewestFirst、各 rollback-together、
  grants、sweep retention）原样通过 = 迁移无漂移证据；新增 auditlog sentinels 全部通过
  （AppendCommits/AppendFailureRollsBack/RejectsOutsideVocabulary/CallerRollbackDiscards/
  ConcurrentAppendsAllLand/SnapshotSubjectRefusesUnknownUsers）。
- `git diff --name-status main` 只含上述 task-owned 路径（auditlog 新包、identity 迁移点、
  harness 脚本、.scratch 记录），无夹带。

## Rollback

单 PR 单 squash commit，revert 即回原 `identity/audit` seam。
