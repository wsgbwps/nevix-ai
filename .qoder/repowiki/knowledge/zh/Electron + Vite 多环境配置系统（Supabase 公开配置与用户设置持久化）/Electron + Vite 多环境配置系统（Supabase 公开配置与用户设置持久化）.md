---
kind: configuration_system
name: Electron + Vite 多环境配置系统（Supabase 公开配置与用户设置持久化）
category: configuration_system
scope:
    - '**'
source_files:
    - apps/desktop/electron.vite.config.ts
    - apps/desktop/src/shared/config/supabase-public-config.ts
    - apps/desktop/src/renderer/src/features/authentication/api/environment.ts
    - apps/desktop/src/main/settings/language-mode-store.ts
    - apps/desktop/.env.local
    - apps/desktop/electron-builder.yml
    - apps/desktop/tests/auth/harness/supabase/config.toml
---

本仓库的配置系统围绕 Electron-Vite 构建管线，采用「环境变量注入 + 运行时策略校验 + 本地文件持久化」三层模式管理应用配置。核心设计如下：

1. **构建期环境变量加载**：`electron.vite.config.ts` 通过 `loadEnv(mode, process.cwd(), '')` 按构建 mode（development/test/production）加载 `.env*` 文件，并优先使用进程级 `process.env` 覆盖。Supabase 相关变量以 `VITE_SUPABASE_*` 前缀暴露给渲染进程，作为全局常量 `__NEVIX_SUPABASE_URL__`、`__NEVIX_SUPABASE_PUBLISHABLE_KEY__`、`__NEVIX_SUPABASE_CONFIG_POLICY__` 注入。

2. **运行时安全策略校验**：`src/shared/config/supabase-public-config.ts` 提供 `parseSupabasePublicConfig` 函数，根据 mode 自动选择策略（development/test → `private-network-http`，production → `https-only`），严格校验 URL 协议、主机名（仅允许 localhost/私有网段）、publishableKey 格式（正则 `/^sb_publishable_[A-Za-z0-9_-]{20,}$/`），非法配置直接返回 `undefined`，从源头阻断不安全连接。

3. **渲染进程配置读取**：`src/renderer/src/features/authentication/api/environment.ts` 的 `readSupabasePublicConfig()` 将构建时注入的全局常量传入解析器，统一对外暴露安全的 Supabase 公开配置。

4. **用户设置持久化**：主进程通过 `src/main/settings/language-mode-store.ts` 将语言模式等用户偏好存储于 `app.getPath('userData')` 下的 `language-mode.json` 文件，读写时进行类型校验，缺失或无效值回退到 `DEFAULT_LANGUAGE_MODE`。

5. **打包与资源隔离**：`electron-builder.yml` 明确排除 `.env*`、源码、测试等敏感/开发文件，仅打包必要产物；`extraResources` 和 `asarUnpack` 控制本地化资源与权限描述文件的打包方式。

6. **测试环境配置**：E2E 测试使用独立的 Supabase 本地实例，配置文件位于 `apps/desktop/tests/auth/harness/supabase/config.toml`，包含 API、DB、Auth、Email、Storage 等模块的详细开关与端口映射。

7. **Go 后端配置现状**：当前 `server/cmd/server/main.go` 硬编码监听 `:8080`，未引入任何配置加载机制，属于最小骨架状态。

约定与约束：
- 所有需暴露给渲染进程的变量必须以 `VITE_` 前缀命名，由 Vite 自动注入。
- Supabase 公开配置必须经过 `parseSupabasePublicConfig` 校验，禁止直接使用原始环境变量。
- 用户设置文件路径固定为 `app.getPath('userData')` 下的 JSON 文件，键名与类型由共享 i18n 契约约束。
- 生产环境强制 HTTPS，仅 development/test 允许 HTTP 且仅限 localhost/私有网段。