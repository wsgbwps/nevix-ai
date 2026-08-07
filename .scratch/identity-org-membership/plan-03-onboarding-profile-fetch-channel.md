# 03 Onboarding / Profile / Fetch Channel 实施计划

## 范围与归属

- **主 Domain：Organization**。组织 onboarding 的 renderer 实现在 `apps/desktop/src/renderer/src/features/organization/`；顶层路由仅在 `app/routes/` 组装。
- **支持 Domain：Profile**。全局 Profile 的读写和显示名编辑归 `apps/desktop/src/renderer/src/features/profile/`；设置页继续由 `app/pages/` 聚合，不创建 Settings Domain。
- **路由例外已文档化并受运行时约束**。Organization Domain 的 `model/` 拥有 onboarding eligibility：它只在 User 刚验证、尚未完成该向导时允许唯一的 authenticated pre-shell 顶层视图全屏渲染；完成或 composed Authentication lifecycle 结束时清除该资格，并进入 App Shell。ADR-0004 和 Desktop AGENTS 明确这项窄例外，其他 authenticated Domain views 继续在 App Shell 内容区内。
- 直连 Supabase 的普通、受 RLS 保护的 Profile CRUD 留在 renderer；CreateOrganization 是跨事务的可信命令，renderer 只以当前 User 的 Bearer JWT 调用已由 ticket 02 交付的 Server HTTP interface。不会新增 IPC 代理、数据库迁移或 OpenAPI 变更。

## 安全与实施步骤

1. 在 Desktop 现有 build/runtime 配置 owner 中校验 `VITE_SERVER_URL`，缺失或非法时在启动边界显式失败；CSP 的 `connect-src` 只加入该 URL 的精确 origin，不使用通配符。Server 既有 `CORS_ALLOWED_ORIGINS` 仍是独立的部署白名单：开发 renderer 的精确 origin 由部署配置列入；packaged `file://` renderer 的请求不带 Origin，按既有 Go CORS contract 放行。不会改动可信命令的 CORS 策略。
2. 在各 Feature 的 `api/` 内通过现有 Supabase public configuration 和当前 Session 使用 RLS 访问 `profiles`，并通过已存在的 Server contract 发起 CreateOrganization。不会暴露 service-role、数据库或第三方密钥。
3. 以 Profile-owned 和 Organization-owned UI/model 实现基线规定的显示名和组织名校验、两步 onboarding、失败后的同一客户端组织 ID 重试，以及 Profile 设置区的脏检查和保存反馈；所有新可见文案放入所属 Feature 的中英文资源。为让真实测试 server 启动，`server/cmd/server/main.go` 仅将 Identity Module 注册到 chi 子路由组，避免既有 `/health` 路由后追加 Module middleware 的 panic；这是 composition-root wiring 修复，不改变 Module、HTTP contract 或可信执行 seam。真实 GoTrue ES256 JWT 同时揭露既有 verifier 误将 JWS signing input 直接交给 ECDSA；修复为按 ES256 标准先 SHA-256 后验签，并以标准签名 regression test 锁定。
4. 仅在 `app/` 组合认证状态、顶层 onboarding route、App Shell / Settings Page；不把业务逻辑放入 composition root，也不让 Feature 相互导入。

## 验证与回滚

- 在既有 Playwright Desktop e2e seam 覆盖注册到 onboarding、字段校验、上一步、创建 Organization 后进入 App Shell，以及 Profile 编辑的外部可见行为。测试 runner 复用根 `supabase/` 的已提交 schema/migration，启动已交付的 Go CreateOrganization server；不复制 SQL 或以 mock 替代受信命令。根 local Supabase config 使用明确标注、仅限本地开发/CI 的 ES256 JWK fixture，使 GoTrue JWKS 与 ticket 02 的 ES256-only verifier 相符；它不是部署密钥、不会被 production config 复用。根 local auth config 同时启用已有的密码变更双语通知模板，以保留 Desktop 既有真实恢复 e2e 行为。
- 运行相关单测/e2e、Desktop typecheck、localization 发布检查和最终完整测试套件；复核 CSP 与请求不会将 JWT 或秘密写入日志。
- 回滚只回退本分支代码；ticket 02 的 CreateOrganization API 和已存在的 RLS/schema 不受本 ticket 修改。
