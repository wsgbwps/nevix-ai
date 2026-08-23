# #105 桌面端 Admin 用户管理与审计界面 — 实施计划

## Acceptance boundary

Issue #105 五条验收（Admin 治理动作全覆盖、用户列表分页+搜索+全员目录、审计日志分页+导出、
member 不可见、E2E 核心管理流），全部以真实 Go server + Postgres 的 E2E 与单测验证；
服务端端点已由 #102 落地（contracts/identity.yaml 0.5.0），本票零服务端改动。

## Fixed point

main @ 0a10bdb（5/7 连接基座已合入；server URL 为运行时配置，E2E 经 seedServerConnection 注入）。

## Primary Domain 与 task-owned paths

Desktop 域。新增 canonical Domain `user-management`（对齐 spec「用户管理界面」词汇），出现在它实际需要的三个 seam：

- `apps/desktop/src/shared/ipc/user-management/types.ts` — export-audit-log Channel 声明
- `apps/desktop/src/main/user-management/ipc/{index,export-audit-log}.ts` — 审计导出的原生保存对话框 Handler
- `apps/desktop/src/renderer/src/features/user-management/` — api/ lib/ model/ ui/ i18n/

既有文件的窄改：

- `app/settings/settings-navigation.ts` + `settings-page.tsx` — 新增 `users` / `audit` 两个 Admin-only
  Settings Section（Registry 行 + 渲染 + 导航分组 + 非 Admin clamp）
- `features/authentication/model/use-authentication.ts` — 暴露 `userRole`（镜像既有 `userEmail`）
- `app/i18n/renderer-i18n.ts`、`tests/i18n/resource-contract.spec.ts` — 注册 userManagement 命名空间
- `shared/ipc/channel-allowlist.ts` — 新 Channel 入册
- `apps/desktop/CONTEXT.md` — Desktop 词典按预告入册（User Management Domain 等词群）
- 新测试：`tests/settings/admin-user-management.spec.ts`、`tests/unit/user-management-*.test.mts`

## 设计要点

- **角色门控**：Settings 侧边栏「管理」分组（用户管理 / 审计日志）仅 `userRole === 'admin'` 渲染；
  member 的 history state 指向 Admin Section 时 clamp 回 profile。授权真相在 server（403 不可达，UI 门控仅为可见性）。
- **管理列表**：`GET /identity/admin/users`（含停用账号 = 全员目录），email 升序，page/per_page 分页
  （per_page=20），q 搜索（300ms 防抖）匹配 email/display_name。行内动作：改角色（Select）、改 email、
  重置密码（对话框）、停用（确认）、删除（仅 last_login_at 为 null 的账号可点）。
- **建号**：对话框（email + 初始密码 + 可选显示名），成功后刷新列表并提示。
- **贡献语义**：治理命令 in-flight → navigate: blocked / close: deny；审计导出 in-flight 同理（沿袭
  organization 时代 MembersSettings/AuditLogSettings 的 SettingsLeaveSemantics 贡献模式）。
- **审计**：`GET /identity/audit-logs` 分页 newest-first；导出拉全部分页 → CSV（公式注入防护、CRLF）
  → `user-management:export-audit-log` IPC（trusted sender 校验 + showSaveDialog + 写文件；
  E2E 模式经 NEVIX_TEST_AUDIT_LOG_EXPORT_PATH 落盘断言）。
- **错误呈现**：email_taken / last_admin_protected / user_has_logged_in / password_too_short /
  invalid_email / user_not_found 等契约错误码映射为明确文案；401 按 load-failure 呈现（会话边界由认证面接管）。

## 测试映射（QA 验收 → 检查）

1. 治理动作全覆盖 → E2E：建号/停用全流程 + 改 email/重置/改角色/删号断言（角色改到 admin 再回 member 避开末位 admin 保护干扰）；单测：client 请求形态与错误映射。
2. 分页 + 搜索 + 全员目录 → E2E：搜索框过滤、翻页控件；列表含 bootstrap admin（含自身）+ 新建号。
3. 审计分页 + 导出 → E2E：审计 Section 可见 user_created 行；导出后 CSV 文件存在且表头/行正确。
4. member 不可见 → E2E：member 的设置导航无「管理」分组与两个 Section 按钮。
5. 核心管理流 → E2E：admin 建号 → 第二个 Electron 实例以新号登录走首登强制改密 → admin 停用 → 该号 session 401、登录 account_disabled。

门：typecheck / lint / unit / component / verify:architecture / run-e2e.sh full。
