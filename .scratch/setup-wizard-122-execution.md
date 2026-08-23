# 首启设置码向导 — 执行附录（issue #122）

实施计划主体见 `.scratch/setup-wizard-bootstrap-plan.md`（决策出自 2026-08-23 grilling，ADR-0015 已修订）。
本附录记录实施期在探索代码后落定的细节，作为高风险变更（认证/bootstrap）的开工前书面计划。

## 固定边界

- 固定点：`main` @ bcdc0b4（加入码自注册 #125 已合入）
- Primary Domain：Server identity（auth 子包）；次要：Desktop authentication
- 任务自有路径：
  - `server/internal/identity/auth/setup.go`（新）、`auth/bootstrap.go`、`auth/sessions.go`（仅 Service 字段）、`routes.go`、`audit/log.go`
  - `server/internal/identity/integrationtest/setup_wizard_test.go`（新）
  - `contracts/identity.yaml`、`contracts/openapi.yaml`
  - `apps/desktop/src/renderer/src/features/authentication/`（api/client.ts、model/use-authentication.ts、ui/authentication-screen.tsx、i18n/resources.ts）、`app/routes/auth.tsx`
  - `apps/desktop/tests/unit/identity-api-client.test.mts`、`apps/desktop/tests/auth/setup-wizard.spec.ts`（新）、`apps/desktop/tests/auth/helpers/identity-server.ts`、`apps/desktop/scripts/run-e2e.sh`

## 实施决策

1. **设置码存放**：`auth.Service` 上的不可变字段，构造时（Bootstrap 之后）在空库上生成一次；
   进程内存即生命周期 —— 重启换码、实例初始化后不再生成由「构造时读库」+「initialize 事务内复检空库」共同保证，
   不做清空字段的额外状态机（复检在锁内先于码比较，409 恒先于码判定，陈旧码不可用）。
2. **码比较**：`crypto/subtle.ConstantTimeCompare`，比对前 trim + 大写化（Crockford base32 大小写不敏感，与注册码一致）。
3. **advisory lock key**：`0x534554555041444D`（"SETUPADM"）；`initialize` 写事务与 `bootstrap.go` 的 env 通道写事务共用，
   两边都在锁内复检空库，先到先得，initialize 输家 409 `instance_already_initialized`，env 输家维持「忽略并告警」语义。
4. **错误顺序**：limiter（复用登录 limiter，per-email）→ bcrypt → 事务{锁 → 复检空库（非空即 409）→ 码比对（403 `invalid_setup_code`）→ 插入首个 admin（`must_change_password=false`）+ session + `last_login_at` + 审计 `setup_admin_created`}。
   email_taken 在该端点不可达（锁内已证空库），契约不设该错误。
5. **日志**：`slog.Warn` 打印一次，`setup_code=XXXX-XXXX`（无空格，可 grep）；非空库不生成、不打印。
6. **状态端点**：`GET /identity/setup/status` 公开，仅 `{initialized: bool}`，实时读库。
7. **E2E 第二台空 server**：主 server 端口硬编码 `:8080` 且 PORT 可配属 Docker 交付 issue（#99 Out of Scope），
   故 E2E 以 Docker 容器跑第二个 server 二进制（`GOOS=linux CGO_ENABLED=0` 交叉构建），与 postgres 同一 user-defined bridge 网络
   （容器内经 `postgres:5432` 连独立的 `setup_wizard` 空库），宿主发布 `127.0.0.1:8081`；脚本从容器日志解析设置码导出
   `NEVIX_TEST_SETUP_SERVER_URL` / `NEVIX_TEST_SETUP_CODE`。

## 验收对照

Issue #122 的 8 条验收标准逐条由 Seam A 测试（生成/换码/status/201 形态/竞态/码错限速审计）与 Seam B E2E
（向导建 admin、第二设备只见登录）覆盖，OpenAPI 契约一致性由 `assertContractResponse` 防线把守。
