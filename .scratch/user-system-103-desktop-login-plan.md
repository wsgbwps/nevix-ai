# Issue #103 — 桌面端登录重造与 Supabase 摘除：实施计划

高风险变更（认证面 + 凭据本地存储），按 AGENTS.md 要求先写计划。
Fixed point：`main` @ 06a164a。父 spec #99；依据 ADR-0014 / ADR-0015。
阻塞票 #100 / #101 / #102 均已 CLOSED；后继票 #104（运行时连接基座）、
#105（Admin 用户管理 UI）、#106（测试栈与 CI 收尾）不为本票所代劳。

## 范围边界

- 只做 #103：authentication Feature 改造为 Go API 客户端（登录 / 登出 /
  首登强制改密 / me），organization Feature 整体删除，profile 显示名编辑
  迁移到 Go API，supabase-js 与 `VITE_SUPABASE_*` 构建注入摘除，E2E 栈
  换成「临时 Go server 二进制 + 临时 Postgres」。
- 暂用既有构建期 server URL 注入（`VITE_SERVER_URL` → `__NEVIX_SERVER_URL__`，
  策略解析沿用 `server-public-config.ts`）；运行时连接屏、TOFU、设置页
  server URL 编辑归 #104。
- 不做：Admin 用户管理 / 审计界面（#105）、SSE、自助改密的设置页入口
  （无任何票的 AC 覆盖，PR 中作为缺口记录）、mail-smoke / auth-policy
  harness 拆除与 README 修正（#106）。
- `supabase` CLI devDep：desktop 侧随 E2E 重造移除；root 侧保留（auth-policy
  harness 仍用，#106 拆）。

## 关键决策

1. **API 客户端形态**：沿用既有 command-client 模式——renderer 直接
   `fetch(new URL(path, config.url))`，Bearer 头携带 opaque token，错误只按
   契约 `error` 码分支（`unauthorized` / `invalid_credentials` /
   `account_disabled` / `login_rate_limited` / `password_change_required` /
   `invalid_password`）。每个 Feature 自持 api/ 段（authentication 与
   profile 各自的小客户端），无共享网络层。
2. **会话状态机**：`restoring → {configuration-error | restore-failure |
   unauthenticated | password-change-required | authenticated}`；去掉 flow
   概念。restore = IPC 读 token → `GET /identity/users/me` 验证（401 清本地
   回登录 + session-expired 通知；网络不可达 → restore-failure 可重试边界）。
   登录响应 `must_change_password=true` 或业务 403 `password_change_required`
   → 进入强制改密；改密成功（同会话存活）→ authenticated。
3. **本地凭据**：既有 `authentication-session.enc`（safeStorage 信封、原子
   写、版本化）机制不变；canonical schema 换为本票定义的
   `{token, expires_at, user:{id,email,display_name,role,must_change_password}}`，
   main 侧 canonicalize 同步重写。IPC 契约（channel 名与 `session: string`
   载荷）不变。
4. **运行中吊销的可见性**：#103 无 SSE / 无轮询——吊销在下次 API 接触时
   显形（restore 401 → 登录；已登录内的用户动作失败呈错误态）。E2E 的
   runtime-revocation 以「吊销 + 重启 → 登录面」与「设置页动作 401」验证。
5. **路由与 Startup Surface**：`resolveStartupSurface({status, pathname})`
   收敛为认证状态二分：非 authenticated（含 password-change-required）→
   `/auth`；authenticated → outlet（`/auth` 重定向回 `/`）。删除
   onboarding / select-organization 路由与 org 启动阶段视图。
6. **Settings**：section 收敛为 `profile` + `language`（scope 仅剩 account）；
   删除 org picker 页与其协调器分支；`createSettingsEntry` 去 organizationId。
7. **显示名编辑**：留在 profile Feature（窄 Domain 存续），api 改
   `GET/PATCH /identity/users/me`；`hasCompletedProfile` / `saveProfile`
   onboarding 耦合删除。
8. **E2E 栈**：`run-e2e.sh` 以 `docker run postgres:17.5-alpine`（固定宿主
   端口 + 随机容器名）替换 Supabase CLI 栈；按 test-identity-integration.sh
   的方式置备 owner/identity_app 双 DSN；server 以
   `DATABASE_URL`/`MIGRATION_DATABASE_URL`/`CORS_ALLOWED_ORIGINS`/
   `ADMIN_EMAIL`/`ADMIN_INITIAL_PASSWORD` 启动（移除 JWKS/SMTP/OUTBOX 注入）。
   Playwright 侧 helper 改走 Admin API（bootstrap admin 登录 →
   `POST /identity/users` 建号 / 停用 / 重置密码），无直连 DB 依赖。
   失败注入的代表性 spec 换为首登改密 smoke。desktop-e2e-ci.yml 的 e2e
   job 摘除 supabase-image-cache / harness 自测 / supabase teardown 步骤
   （auth-policy job 原样留给 #106）。

## 测试计划

- 单元：startup-surface（新二分语义）、settings-navigation（两 section）、
  session 信封 canonicalize（新 schema）、IPC allowlist drift 随 channels
  收敛自动通过。
- 组件：authentication-transition 改为 mock Go 端点（登录 → 改密 → shell
  转场）；organization-startup 删除。
- E2E（AC1 核心）：login-boundary（有效/无效/停用/限速）、
  first-login-change-password（首登 → 强制改密 → shell → 登出 → 新密码重登；
  含错误现密码分支）、session-persistence（重启仍登录）、
  runtime-revocation（吊销 + 重启 → 登录）、remembered-email、
  password-visibility、configuration（构建矩阵：缺 URL / 非法 URL /
  production 私网 http 拒绝）、electron-security、app-shell、
  settings-page（显示名编辑端到端 + discard）、i18n / window / startup
  既有 spec 换新 sign-in helper。
- 删除：signup-verification、password-recovery、organization/*、
  settings-organization-picker、supabase-auth / mailpit / organization-seed
  helpers、tests/auth/harness/supabase。

## 验收对照（#103 逐条）

1. E2E 全通（Go server + Postgres 栈）→ first-login-change-password 等 spec 族 ✓
2. supabase-js / VITE_SUPABASE_* 消失 → 依赖与构建注入删除 + grep 哨兵 ✓
3. organization Feature 删除 + 词典清理 → 目录删除 + CONTEXT.md 讣告注记回收 ✓
4. 注册 / 验证码 / 找回密码删除 → UI/model/i18n/E2E 全拆 ✓
5. 显示名编辑迁入可用 → profile Feature 接 PATCH /users/me + settings E2E ✓
6. opaque token 入加密存储 + 不可达错误态 → 信封机制延续 + restore/login
   不可达分支 E2E ✓
