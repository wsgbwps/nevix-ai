---
kind: error_handling
name: 错误处理：Electron 主进程安全边界与渲染进程状态机式错误分类
category: error_handling
scope:
    - '**'
source_files:
    - apps/desktop/src/main/ipc/authentication/trusted-sender.ts
    - apps/desktop/src/main/ipc/authentication/clear-session.ts
    - apps/desktop/src/main/ipc/authentication/read-session.ts
    - apps/desktop/src/main/ipc/authentication/replace-session.ts
    - apps/desktop/src/main/authentication/session-store.ts
    - apps/desktop/src/renderer/src/features/authentication/hooks/use-authentication.ts
---

本仓库的错误处理策略按进程分层，采用「主进程严格校验 + 渲染进程有限状态机」的组合模式，Go 后端目前仅保留最小骨架。

1. Electron 主进程（main）——防御性编程与结构化结果
- IPC 处理器统一通过 requireTrustedSender 在入口处验证调用来源，非受信任渲染器直接 throw new Error(...) 拒绝访问（见 trusted-sender.ts）。
- 参数合法性由每个 handler 显式检查并抛出明确错误消息（如 clear-session.ts、read-session.ts、replace-session.ts），不允许隐式失败。
- 持久化存储使用「结构化结果」而非异常：session-store.ts 的 readPersistedSession/replacePersistedSession 返回 { outcome: 'empty' | 'unreadable' | 'unavailable' | 'persisted' | 'session' }，将 I/O 失败、格式校验失败、加密不可用等路径全部归入枚举值，避免异常传播到上层。
- 所有可能失败的副作用（文件删除、清理 pending 文件等）都使用 .catch(() => undefined) 静默兜底，确保清理操作不会中断主流程。

2. 渲染进程（renderer）——类型安全的错误分类与状态机
- use-authentication.ts 定义 AuthenticationError 联合类型：'invalid-credentials' | 'invalid-verification-code' | 'rate-limited' | 'service-unavailable'，并通过 Supabase AuthApiError.code 白名单映射到这些语义化错误码。
- 认证状态机包含 'restoring' | 'configuration-error' | 'restore-failure' | 'unauthenticated' | 'authenticated' 五种状态，配合 AuthenticationNotice（'session-expired' | 'remote-sign-out-delayed'）区分可恢复错误与用户提示。
- 速率限制通过 isRateLimited 函数集中判断（HTTP 429 或特定 code），登录/注册/验证码重发等路径统一复用该逻辑。
- 恢复失败被细分为「可重试」（restore-failure）和「终止性」（isTerminalRestoreFailure 中 AuthSessionMissingError 或 4xx 非 429），只有明确的终端错误才会清除本地会话。

3. Go 后端（server）——当前为空骨架
- server/cmd/server/main.go 仅暴露 /health 端点并使用标准库 log.Fatal 启动 HTTP 服务，尚未实现任何业务错误或中间件。
- server/pkg/middleware 目录存在但为空，server/internal 也为空，表明错误处理体系尚未在后端落地。

4. 设计约束与约定
- 主进程不向渲染进程传递原始错误对象，仅通过 IPC 返回值或结构化结果表达成功/失败。
- 渲染进程不依赖全局错误捕获，每个异步操作都有独立的 try/catch 并将错误归一化为有限集合。
- 安全相关错误（未授权来源、非法 Session 载荷）立即抛错；I/O 与网络错误通过结构化结果或状态机字段表达。
- 测试环境通过环境变量（NEVIX_E2E、NEVIX_TEST_FORCE_BASIC_TEXT_STORAGE、NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE）模拟加密不可用等边界条件。