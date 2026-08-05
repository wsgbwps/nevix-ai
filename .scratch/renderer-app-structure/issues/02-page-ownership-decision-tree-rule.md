# 02 — 页面归属决策树写入仓库规范

**What to build:** 把票 01 落地后的页面归属约定写成明文规范，使未来任何 contributor / AI agent 新增页面时无需自由裁量。`apps/desktop/AGENTS.md` 的 Renderer 小节新增决策树：业务 Domain 页面放对应 `features/<domain>/` 并经 public index 导出；跨 Feature 聚合页与无 Domain owner 的页面放 `app/pages/`；App Shell 内部结构放 `app/shell/`；`app/` 根禁止新增页面文件；禁止建立 `settings` 同名 Feature（settings 不是 Domain 名）。`README.md` 的 renderer 目录树同步补上 `app/pages/` 与 `app/shell/`。规则文本必须与实际结构一致。

**Blocked by:** 01 — 结构迁移：聚合页面收编 app/pages/，App Shell 迁入 app/shell/

**Status:** ready-for-agent

- [ ] `apps/desktop/AGENTS.md` 包含完整页面归属决策树（全部去向 + 禁止项）
- [ ] `README.md` renderer 目录树包含 `app/pages/` 与 `app/shell/`，职责注释准确
- [ ] 文档描述与票 01 落地后的实际结构逐项核对一致
- [ ] lint、typecheck 通过，CI 绿
