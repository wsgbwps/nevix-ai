# Plan — 用户系统迁移 1/7：服务端基线（#100）

Parent spec: #99. ADRs: 0013 / 0014 / 0015.

## Boundary

- **Acceptance boundary**: issue #100 的 10 条验收标准，由新 Seam A 集成测试
  （Module 公开契约 → HTTP → 真 PG）+ 单元测试 + CI 验证。
- **Fixed point**: `origin/main` @ 9422ed7。工作区已有 staged 的 ADR/docs 变更，
  属 config/docs fast lane，不在本任务提交内，保持原样。
- **Primary Domain**: Server — identity Module（用户系统演化）。共享面新增：
  `internal/authz`（授权 guard 词汇，ADR-0015 单一落点）、`internal/migration`
  （跨 Module 版本化 migration runner）、`contracts/`（OpenAPI 重写）。

## Key decisions

1. **Migration**：`internal/migration` runner——embedded SQL、`schema_migrations`
   版本表、pg advisory lock、up-only。composition root 启动时以
   `MIGRATION_DATABASE_URL`（DDL 凭据）执行后关闭，应用 pool 仍是
   `DATABASE_URL` = identity_app（ADR-0014「owner/migration 凭据跑应用非法」）。
   基线 `0001` 建 users / sessions / audit_logs + identity_app 角色与最小 GRANT；
   无生产数据，不做旧对象 drop（fresh PG 世界，ADR-0015）。
2. **authz**：`internal/authz` Guard（RequireActiveUser / RequireAdmin）+
   Principal + context，认证经 identity 提供的 SessionAuthenticator 接口；
   `command.Route` 增加声明式 `Guard` 字段，Mount 按 policy 挂中间件。
3. **auth（identity 子包）**：bcrypt(cost 10)；opaque token 32B base64url、
   库内只存 SHA-256 hash；30 天滑动过期（剩余 <15 天时顺延）；进程内 per-email
   登录失败限速（15 分钟 5 次 → 429 + Retry-After）；bootstrap 在 NewModule 内
   空表时建首个 admin（must_change_password=true），非空忽略并告警；
   RunWorkers = 每日 sweep（过期 session 清理 + must_change_password 持续提醒日志）。
4. **端点**：`POST /identity/auth/login`（public）、`POST /identity/auth/logout`、
   `GET /identity/users/me`（均 RequireActiveUser）。审计动作
   session_created / session_revoked / bootstrap_admin_created 与写操作同事务。
5. **CI**：server-ci 跑 `go vet` + 单测 + 新纯 Postgres harness
   （`scripts/test-identity-integration.sh` 重写，pinned docker postgres）；
   删 `scripts/test-mail-smoke.sh`、`mail-smoke-ci.yml`；classifier 去掉 identity
   job；本 PR 标 `skip-e2e`（desktop E2E 待 5/7 与服务端新面重造）。

## Test plan (per AC)

- 空库 bootstrap / 非空忽略 / 空库无 env 告警 — bootstrap_test.go
- 登录签发 token（库存 hash）、多设备并存、滑动过期、登出仅吊销当前会话 — login_session_test.go
- 重启后会话有效（重建 Module = 新进程等价，无内存 session 状态）— login_session_test.go
- bcrypt 哈希、失败限速（429+Retry-After、成功清零）— 单元 + 集成
- schema 基线 / 角色与 GRANT / RLS 无 / 写事务身份复验（既有 startup + writetx 测试沿用）— migration_test.go, startup_identity_test.go
- guard 词汇声明式挂载 — authz 单元测试 + 集成 401/403 行为
- 全部端点进 OpenAPI 且响应对照契约 — contract conformance 机制沿用
- migration up-only、启动自动执行 — migration_test.go（重复 Apply no-op）
- server CI 纯 Postgres — server-ci.yml 本身
- 编译绿灯（旧域连体删除）— go build / go vet

## Risks / notes

- desktop E2E 与新 API 面不兼容至 5/7 落地：PR 标 `skip-e2e`，PR 描述说明。
- `Makefile` 的 `server-mailpit` 删除（outbox 消亡）；`supabase/` 目录本票不动。
- 运行中的本地 Supabase dev stack 与新 harness 完全隔离（独立端口 + lock）。
