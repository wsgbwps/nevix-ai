# Code review ledger — issue #100 server baseline

schema: code-review-findings/v1
fixedPoint: 4fd3a1437dabb6f184ba2acc0612db10d622c9c3 (origin/main merge-base)
scopePaths:
  - server
  - scripts/test-identity-integration.sh
  - scripts/classify-ci-changes.mjs
  - scripts/tests/classify-ci-changes.test.mjs
  - .github/workflows
  - Makefile
  - contracts
  - server/CONTEXT.md
  - README.md
  - .scratch/server-baseline-100-plan.md
fullReviewCount: 1
targetedReviewRound: 2
currentDiffDigest: sha256:a499a1384ffe3e9511ee80ec752383a67f5d21c6400b46d7a61c9ca46cd86bca

## Findings

### CR-STANDARDS-0001 — drop-rebuild 缺失
- identity: {owner: server/internal/migration/migrations, source: ADR-0013/0015, anchor: server/internal/migration/migrations/0001_baseline_user_system.sql (baseline), defect: baseline 假设空库，未 drop 旧多组织对象，残留 legacy schema/RLS 或在重建 audit_logs 时失败}
- level: blocker, disposition: accepted, status: fixed-pending-review
- evidence: reviewer bundle v1 c97c8136 (baseline 无 DROP 语句)；修复：baseline 头部新增 DROP SCHEMA identity CASCADE + 6 张 legacy 表 DROP；legacy_upgrade_test.go 在私有 scratch 库上证明旧世界被清空后重建；migration_test.go 断言 baseline 不再 CREATE legacy 表
- reviewedDiffDigest: sha256:c97c81364f2886b6d0be3c4359cc6b58c090dd0e206d058ff6aff3c733c110b5
- unresolvedTargetedRounds: 0, introducedBy: null

### CR-STANDARDS-0002 — 审计 365 天保留 sweep 缺失
- identity: {owner: server/internal/identity/auth, source: ADR-0009, anchor: server/internal/identity/auth/sessions.go sweepOnce, defect: 日 sweep 只删过期 session，audit_logs 无限增长}
- level: blocker, disposition: accepted, status: fixed-pending-review
- evidence: 修复：sweepOnce 在同一写事务内 `DELETE FROM audit_logs WHERE created_at < now()-365d`（auditRetention 常量）；TestSweepDeletesAuditRowsPastRetention 验证 366 天旧行被删、新行保留
- reviewedDiffDigest: sha256:c97c81364f2886b6d0be3c4359cc6b58c090dd0e206d058ff6aff3c733c110b5
- unresolvedTargetedRounds: 0, introducedBy: null

### CR-STANDARDS-0003 — OpenAPI 请求形态未强制
- identity: {owner: server/internal/identity/auth, source: contracts/identity.yaml requestBody, anchor: auth/commands.go LoginRequest.Validate + command/pipeline.go serve, defect: 缺 password 字段返回 401 而非 400 invalid_request；JSON null body 被接受}
- level: blocker, disposition: accepted, status: fixed-pending-review
- evidence: 修复：Email/Password 改为 *string（缺失 → 400 invalid_request；存在但为空串 → 401）；pipeline 先解 RawMessage 并拒绝 null/非对象；集成测试覆盖 5 类形态（missing/null/数组/空串等）
- reviewedDiffDigest: sha256:c97c81364f2886b6d0be3c4359cc6b58c090dd0e206d058ff6aff3c733c110b5
- unresolvedTargetedRounds: 0, introducedBy: null

### CR-STANDARDS-0004 — 审计快照未在写事务内取
- identity: {owner: server/internal/identity/auth, source: ADR-0009, anchor: auth/sessions.go issueSession/revokeSession, defect: actor 显示名在事务外读取，并发改名写入历史失真快照}
- level: blocker, disposition: accepted, status: fixed-pending-review
- evidence: 修复：新增 snapshotUser(ctx, tx, userID) 在写事务内 SELECT id/display_name，login/logout 审计行改用事务内快照
- reviewedDiffDigest: sha256:c97c81364f2886b6d0be3c4359cc6b58c090dd0e206d058ff6aff3c733c110b5
- unresolvedTargetedRounds: 0, introducedBy: null

### CR-STANDARDS-0005 — .env.example 陈旧（hook 阻断，需人工）
- identity: {owner: user（repo hook 阻止 agent 编辑 .env*）, source: ADR-0013 env-only 配置, anchor: server/.env.example, defect: 模板仍含已删除的 AUTH_JWKS_URL/SMTP/OUTBOX 变量，缺 MIGRATION_DATABASE_URL 与 bootstrap 变量}
- level: blocker, disposition: accepted, status: closed（owner 决策 A；repair-3 后 owner-directed 复审 closed）
- evidence: 尝试写入被 .pi/extensions/pi-hooks.ts 的 isProtectedEditPath（/\.env(?:\..*)?$/）阻断；用户随后修正 hook（main 072188c，.env.example 模板放行）并授权写入；repair-2 重写模板（fed28ae8…→a9bdc1c0…）；targeted round 2 复审仍判 open：全新 PG 上模板注释自相矛盾（说 migration 创建无密码角色、又让用户启动前 ALTER ROLE 设密——角色在 migration 运行前不存在，首启必然失败）
- unresolvedTargetedRounds: 1（round 2 open → escalated → owner 决策 A → repair-3 → owner-directed 复审 closed）
- reviewedDiffDigest: sha256:c97c81364f2886b6d0be3c4359cc6b58c090dd0e206d058ff6aff3c733c110b5
- unresolvedTargetedRounds: 0, introducedBy: null

### CR-STANDARDS-0006 — README 残留 server-mailpit 工作流
- identity: {owner: README.md, source: 仓库文档化本地工作流, anchor: README.md 常用命令/本地开发启动顺序, defect: 已删除的 make server-mailpit 与 Mailpit/Supabase 启动顺序仍在文档中}
- level: blocker, disposition: accepted, status: fixed-pending-review
- evidence: 修复：README 改写为双 DSN（MIGRATION_DATABASE_URL/DATABASE_URL）+ bootstrap 变量 + scripts/test-identity-integration.sh 的新工作流；grep 确认 server-mailpit/Mailpit 引用清零
- reviewedDiffDigest: sha256:c97c81364f2886b6d0be3c4359cc6b58c090dd0e206d058ff6aff3c733c110b5
- unresolvedTargetedRounds: 0, introducedBy: null

### CR-STANDARDS-0007 — 错误信封写入器重复
- identity: {owner: server/internal/authz, source: Fowler Duplicated Code/Shotgun Surgery, anchor: authz.go writeError vs command.WriteError, defect: 两处 4 行信封需人工同步}
- level: advisory, disposition: deferred, status: closed
- dispositionReason: authz 不得 import identity/command（server/AGENTS.md 模块边界；authz 是被 identity 消费的共享子包，反向依赖成环）；共享第三层违反根规则「不建 synonymous wrapper/新共享层」。两侧均有契约一致性测试锁定字节形态，漂移会被测试捕获。出现第三个写入方时再收敛。
- reviewedDiffDigest: sha256:c97c81364f2886b6d0be3c4359cc6b58c090dd0e206d058ff6aff3c733c110b5

### CR-SPEC-0001 — 集成测试未随 patch 交付
- identity: {owner: server/internal/identity/integrationtest, source: "#100 全部新端点…有 Seam A…集成测试", anchor: scripts/test-identity-integration.sh representative_tests, defect: 声称哨兵测试缺失}
- level: blocker, disposition: false-positive, status: closed
- dispositionReason: 反证：三个测试文件在冻结 bundle 时未 `git add -N`（冻结程序失误，非代码缺失）；测试实际存在于工作树，现已 tracked 并入 v2 bundle；harness 实跑 71 个集成测试零 skip、全部哨兵 PASS（Verified 71 Identity integration tests executed with zero skips）
- reviewedDiffDigest: sha256:c97c81364f2886b6d0be3c4359cc6b58c090dd0e206d058ff6aff3c733c110b5

### CR-SPEC-0002 — 请求形态与契约不符（同 CR-STANDARDS-0003）
- identity: {owner: server/internal/identity/auth, source: "#100 全部新端点进 OpenAPI 契约", anchor: auth/commands.go LoginRequest.Validate, defect: 缺字段/密码为空未按契约分别回 400/401}
- level: blocker, disposition: accepted, status: fixed-pending-review
- evidence: 同 CR-STANDARDS-0003 修复
- reviewedDiffDigest: sha256:c97c81364f2886b6d0be3c4359cc6b58c090dd0e206d058ff6aff3c733c110b5
- unresolvedTargetedRounds: 0, introducedBy: null

### CR-SPEC-0003 — 未 drop 旧对象（同 CR-STANDARDS-0001）
- identity: {owner: server/internal/migration/migrations, source: "#100 organizations…删除；identity schema 取消；RLS 移除", anchor: 0001_baseline_user_system.sql, defect: 未对既有库执行 drop-rebuild}
- level: blocker, disposition: accepted, status: fixed-pending-review
- evidence: 同 CR-STANDARDS-0001 修复
- reviewedDiffDigest: sha256:c97c81364f2886b6d0be3c4359cc6b58c090dd0e206d058ff6aff3c733c110b5
- unresolvedTargetedRounds: 0, introducedBy: null

### CR-SPEC-0004 — go.mod 残留 SMTP 库；.env.example 陈旧
- identity: {owner: server/go.mod, source: "#100 Outbox Worker、JWKS、SMTP…连体删除", anchor: server/go.mod + server/.env.example, defect: wneessen/go-mail 仍在依赖；模板保留已删配置}
- level: blocker, disposition: accepted, status: fixed-pending-review
- evidence: 修复：`go mod tidy` 移除 wneessen/go-mail（grep 0 命中）；.env.example 部分并入 CR-STANDARDS-0005（hook 阻断，待用户）
- reviewedDiffDigest: sha256:c97c81364f2886b6d0be3c4359cc6b58c090dd0e206d058ff6aff3c733c110b5
- unresolvedTargetedRounds: 0, introducedBy: null

## Repair records

### repair-1 (fixFor: CR-STANDARDS-0001/0002/0003/0004/0006, CR-SPEC-0002/0003/0004)
- beforeDigest: sha256:c97c81364f2886b6d0be3c4359cc6b58c090dd0e206d058ff6aff3c733c110b5
- afterDigest: sha256:fed28ae8fa5c87bde3c5feebe2c41709bb7e5734bd6b1158f5b48a769b476443
- touchedPaths:
  - server/internal/migration/migrations/0001_baseline_user_system.sql（legacy teardown）
  - server/internal/migration/migration_test.go（禁止重建 legacy 表断言）
  - server/internal/identity/integrationtest/legacy_upgrade_test.go（新增：scratch 库 drop-rebuild 证明）
  - server/internal/identity/auth/sessions.go（audit 保留 sweep + 事务内 snapshotUser）
  - server/internal/identity/auth/commands.go（LoginRequest 指针字段 + presence 校验）
  - server/internal/identity/command/pipeline.go（null/非对象 body 拒绝）
  - server/internal/identity/integrationtest/login_session_test.go（形态校验 + 审计保留测试）
  - README.md（新工作流，去 server-mailpit）
  - server/go.mod / server/go.sum（移除 go-mail）
- checks:
  - go vet ./... — PASS
  - go test ./...（server，全部包）— PASS
  - ./scripts/test-identity-integration.sh（真 PG 集成套件）— PASS，71 tests，零 skip
  - make harness-test — PASS（19/19）

## Repair record 2 (fixFor: CR-STANDARDS-0005)

- beforeDigest: sha256:fed28ae8fa5c87bde3c5feebe2c41709bb7e5734bd6b1158f5b48a769b476443
- afterDigest: sha256:a9bdc1c085f1bcc057641183d8b0eaa8d981031d8aba92fdfe26f192accf95be
- touchedPaths: server/.env.example（重写为新 env 契约；hook 修正 main 072188c 属 .pi/ fast lane，不在本 bundle）
- checks: ./scripts/test-identity-integration.sh PASS（71 tests 零 skip）；go vet + go test ./... PASS

## Repair record 3 (fixFor: CR-STANDARDS-0005, owner decision A)

- beforeDigest: sha256:a9bdc1c0…
- afterDigest: sha256:a499a138…
- touchedPaths: server/.env.example（首启前 CREATE ROLE identity_app LOGIN PASSWORD 预置说明；migration 采用既有角色且绝不重置密码）、README.md 启动顺序第 2 步（同措辞 + 原因）
- checks: 真 PG 一次性首启冒烟（CREATE ROLE → 单次启动 → migration/bootstrap/login/me 全通）PASS；./scripts/test-identity-integration.sh PASS（71 tests 零 skip）；go vet + go test ./... PASS
- owner-directed 复审（reviewer, digest a499a138…）: CR-STANDARDS-0005 closed，无 repair-3 引入问题

## Owner-directed close (escalation resolution)

- escalated blocker CR-STANDARDS-0005 由 owner 决策 A（应用评审认可的修复文案）解决；上述 owner-directed 复审 closed。

## Targeted re-review round 2

- agent: reviewer (targeted-rereview-2), digest sha256:a9bdc1c0…, target: CR-STANDARDS-0005
- verdict: open——模板称 baseline migration 创建无密码 identity_app、又要求启动前 ALTER ROLE 设密；全新 PG 上角色在首启的 migration 前不存在 → copy-and-run 仍需一次失败首启。修复方向：文档改为「首次启动前 CREATE ROLE identity_app LOGIN PASSWORD ...；migration 的幂等 DO 块采用既有角色且绝不重置密码」（harness 即此模式）
- 无 introducedBy 新发现（"No separate repair-introduced finding"）

## Targeted re-review round 1

- agent: reviewer (targeted-rereview), digest sha256:fed28ae8fa5c87bde3c5feebe2c41709bb7e5734bd6b1158f5b48a769b476443
- results: CR-STANDARDS-0001 closed; CR-STANDARDS-0002 closed; CR-STANDARDS-0003 closed;
  CR-STANDARDS-0004 closed; CR-STANDARDS-0006 closed; CR-SPEC-0002 closed; CR-SPEC-0003
  closed; CR-SPEC-0004 closed. No repair-introduced findings (introducedBy: none).
- unresolved after round 1: CR-STANDARDS-0005 (open; repair blocked by repo hook, owner: user)

relevantCheck:
  name: ./scripts/test-identity-integration.sh (真 PG 集成套件) + go vet/test
  result: PASS
  coverage: 71 integration tests, zero skips; all sentinels PASS; server all-packages unit PASS
  diffDigest: sha256:a499a1384ffe3e9511ee80ec752383a67f5d21c6400b46d7a61c9ca46cd86bca
outcome: closed  # 全部 blocker closed；advisory 均有显式处置（deferred/false-positive + counter-evidence）；最终检查 PASS 且 digest 一致（a499a138…）
