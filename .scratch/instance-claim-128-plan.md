# 默认无凭据、设置码可选的 Instance Claim — 实施计划（issue #128）

Spec：#99（用户系统迁移）。本切片依据 ADR-0013 / ADR-0015 的 2026-08-24 修订（#127 已先行修订两份 ADR 与词典）。
认证域高风险变更：本文件即开工前书面计划。

## 固定边界

- 固定点：`main` @ f03b70e
- 验收边界：issue #128 的 15 条验收标准
- Primary Domain：Server identity（auth 子包）；次要：Desktop authentication
- 任务自有路径（新文件全部 freeze 为 tracked path 供 /code-review 审全量 diff）：
  - `server/internal/identity/module.go`、`auth/setup.go`、`auth/bootstrap.go`（删除）、`auth/sessions.go`（仅 Service 字段）、`auth/register.go`（仅派生显示名改名）、`auth/sweep.go`（仅注释）、`audit/log.go`
  - `server/internal/identity/transport_test.go`、`integrationtest/instance_claim_test.go`（由 setup_wizard_test.go 重命名重写）、`integrationtest/bootstrap_test.go`（删除）、`integrationtest/harness_test.go` 及清除 `cfg.AdminEmail=""` 的各测试文件
  - `contracts/identity.yaml`
  - `apps/desktop/src/renderer/src/features/authentication/{api/client.ts,model/use-authentication.ts,ui/authentication-screen.tsx,i18n/resources.ts}`
  - `apps/desktop/src/renderer/src/features/user-management/{ui/audit-log-settings.tsx,i18n/resources.ts}`
  - `apps/desktop/tests/unit/identity-api-client.test.mts`、`apps/desktop/tests/auth/setup-wizard.spec.ts`、`apps/desktop/tests/auth/instance-claim.spec.ts`（新）、`apps/desktop/tests/auth/setup-probe-failure.spec.ts`（新）、`apps/desktop/tests/auth/helpers/identity-server.ts`、`apps/desktop/tests/helpers/electron-app.ts`、`apps/desktop/scripts/run-e2e.sh`
  - `scripts/test-identity-integration.sh`、`server/.env.example`、`README.md`

## 实施决策

1. **Config 形状**：`identity.Config` 删 `AdminEmail`/`AdminInitialPassword`，增 `SetupCodeRequired bool`。
   `LoadConfig` 严格解析 `NEVIX_SETUP_CODE_REQUIRED`：未设置或空串 → false；字面 `true` → true；字面 `false` → false；
   其他任何值（含 `TRUE`、`1`、`yes`）返回错误拒绝启动。检测到非空 `ADMIN_EMAIL` 或 `ADMIN_INITIAL_PASSWORD`
   即返回错误（getenv 无法区分空串与未设置，空串视为未设置）。
2. **Setup Code 生成时机**：仅 `SetupCodeRequired && users 空` 时构造期生成并打印一次；开放模式不生成不打印。
   实例初始化后（users 非空）构造不再生成。认领成功后立即 `s.setupCode = ""` 清除（内存唯一副本）。
3. **状态端点**：`GET /identity/setup/status` → `{initialized, setup_code_required}`；
   `setup_code_required = 配置要求 && !initialized`（初始化后不存在活码，恒答 false）。两字段都 required，实时读库。
4. **认领命令**：`POST /identity/setup/initialize`（路径不变，语义改写为 Instance Claim）：
   - 校验（Validate）：email/password 必填（缺 → 400 invalid_request）；`setup_code` 指针不再必填。
   - 保护模式：缺 `setup_code` → 400 invalid_request；提供但错误 → 403 invalid_setup_code（常量时间比较，与登录共享 per-email 限速）。
   - 开放模式：`setup_code` 完全忽略（提供与否均可）。
   - 单一写事务：advisory lock → 复检空库（非空 → 409 instance_already_initialized）→ [保护模式码比对] →
     INSERT active admin（must_change_password=false）+ last_login_at + session + 审计 `instance_claimed`
     （metadata：email + `setup_code_required:"true"|"false"`）。成功后清内存码。
   - 并发输家 409；`bootstrap_admin_created`/`setup_admin_created` 从词汇、契约、Desktop 展示、测试整体删除，无兼容。
5. **文件清理**：`auth/bootstrap.go` 删除（`Bootstrap`/`errBootstrapPreempted` 随之消亡）；
   `usersEmpty`、派生显示名（改名 `derivedDisplayName`）移入 `setup.go`，`register.go` 改调用点。advisory lock 键保留（同键同语义：首管先到先得）。
6. **Desktop**：
   - `SetupStatus` 增 `setupCodeRequired`（两布尔都缺失/类型错 → network-failure 降级，不猜）。
   - `initialize` 只在保护模式收集并发送 `setup_code`；开放模式向导不渲染设置码输入。
   - `InstanceSetupState` 增 `probe-failed`：登录边界 settle 后探测失败显示可重试错误面板（不回退普通登录）；重试重新探测。
   - 审计展示：user-management 动作清单与 i18n 替换为 `instance_claimed`。
7. **测试基建**：
   - 集成 harness 删 `NEVIX_ADMIN_EMAIL`/`NEVIX_ADMIN_INITIAL_PASSWORD` 依赖；E2E 主 server 由脚本经公开认领端点
     创建测试 Admin（开放模式、密码自选、无 must_change_password，`stabilize_bootstrap_admin` 删除）。
   - E2E 空实例 server 两个：8081 保护模式（`NEVIX_SETUP_CODE_REQUIRED=true`，日志解析设置码）供 setup-wizard spec；
     8082 开放模式供 instance-claim spec（无码字段 + first-wins 输家 409 回登录）。探测失败 spec 用不可达 URL，无需 server。
8. **验收分配**（15 条 → 覆盖点）：Seam A = 严格布尔解析、旧变量拒启、状态端点、保护模式码语义、
   审计 instance_claimed、并发 first-wins、重启换码、限速、契约一致性；Seam B = 开放向导无码、保护向导显示并校验、
   探测失败可重试、并发输家回登录、成功直登、第二设备仅登录；文档 = 部署注意（认领前不暴露 URL、无离线恢复、双 Admin 建议）；
   契约/共享边界影响列入 PR 说明。无清理 migration（本地/测试库直接重建）。
