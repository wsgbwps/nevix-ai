# 01 — 结构迁移：聚合页面收编 app/pages/，App Shell 迁入 app/shell/

**What to build:** `app/` 收敛为纯 composition root。两个聚合页面实现（Settings、Home）收进 `app/pages/`；App Shell 收进 `app/shell/`，对外 interface 不变（仍导出 `AppShell`），不做内部拆分；`routes/` 下所有文件成为 thin route——只做路由声明与组装，不含页面实现。迁移后 `app/` 根只剩 wiring 文件与生成物。行为零变化，用户无感知。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] SettingsPage 实现位于 `app/pages/` 下，`app/` 根不再有任何页面实现文件
- [x] HomePage 从路由文件中抽出到 `app/pages/`，首页路由文件只做声明与组装
- [x] AppShell 位于 `app/shell/` 下，导出界面与组件行为不变
- [x] `routes/` 下全部文件为 thin route（仅 `createFileRoute` + 组装）
- [x] typecheck、lint、verify:architecture 全部通过
- [x] `tests/settings` 与 `tests/app-shell` e2e 通过
- [x] `routeTree.gen.ts` 若重新生成，已显式 `git add` 后再提交
