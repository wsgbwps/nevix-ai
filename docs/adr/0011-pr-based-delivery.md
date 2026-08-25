# ADR-0011: 基于 PR 的交付(squash merge)

## 状态

已接受 — 2026-04-30;取代 [ADR-0010](0010-verified-sha-landing.md)。

## 背景

ADR-0010 用本地 verified-SHA 落地路线(`make land` + final-state-evidence 本地证据契约)把候选 commit 提升到 `main`。仓库现在是 GitHub Free 私有仓库上的单人开发,而这套本地机器(约 2400 行脚本、hooks 和测试)承担的验收职责——SHA 绑定的检查记录与永久 diff 记录——GitHub PR 页面原生就提供。

## 决策

- `main` 只通过 PR 更新,统一 squash merge(`gh pr merge --squash --delete-branch`);每个任务在 `main` 上恰好一个 commit,PR 页面即验收记录。
- 删除本地 final-state-evidence 证据契约与 `make land` 落地脚本;`docs/specs/final-state-evidence.md` 一并移除,历史由 git 与 ADR-0010 保留。
- 路径感知 CI 在每个 PR 上运行(触及 E2E 相关路径时跑 smoke E2E),合并到 `main` 的 push 再触发一次(E2E 相关时跑 Full E2E Suite);不做无差别全量运行。
- GitHub Free 私有仓库没有服务器端分支保护:合并前的 `gh pr checks --watch` 是实际门禁,本地 hooks 拦截对 `main` 的误提交与误推送。

## 后果

- 历史保持线性,revert 就是一个 revert PR。
- 检查失败不触碰 `main`:在任务分支修复、推送,门禁自动重跑。
- 连续快速合并可能经 `cancel-in-progress` 取消在途的合并后运行;后继运行仍验证自己的合并 diff。
- 将来若启用分支保护,只需把本地 watch 步骤换成 GitHub 强制的 required checks。

## 更新 — 2026-04-30:agent-config 直提快道

仅限 `.pi/`、`.codex/`、`.agents/`、`.omp/`、`.scratch/` 的改动可直接在
`main` 提交并推送:push 触发以 `paths-ignore` 跳过 CI,本地 hooks 仅当待
提交/待推送改动全部落在这五个目录内时放行(信息不可得时拦截)。混合白
名单外路径的推送仍须走 PR。同日扩展:根 `*.md`、`docs/**` 与嵌套 `AGENTS.md`
一并纳入快道——纯文档改动同样跳过 CI 直提直推;产品目录内的其他文档与
`Makefile` 等可执行配置不在此列。

同日第二项更新:合并后的 `main` push 不再跑 E2E。squash merge 的树与
PR head 相同,PR 已验证;合并后重跑只产生重复成本(实测每次约 9 分钟)。
Full E2E 改为按需:给 PR 打 `full-e2e` 标签即在 PR 上升级为全量,
`workflow_dispatch` 保留手动触发。交付机器自身(workflow + 分类器)的
改动也只跑 harness 内联测试,不再触发产品套件。

## 更新 — 2026-08-25:所有纯文档直提 `main`

文档快道从根目录 `*.md`、根 `docs/**` 和两个嵌套 `AGENTS.md`
扩展为任意深度的 `*.md` 与任意 `docs/` 目录下的文件。只要整个
待提交及待推送范围全部属于文档快道,就可直接提交并推送
`main`,无需 PR,且 push 通过 `paths-ignore` 不启动 CI。上述范围可覆盖
Desktop 等 context 内的 ADR、说明文档与文档资产。任一非文档路径混入时,
整个变更恢复 PR 与 CI 流程;非文档快道按下节另行扩展。

## 更新 — 2026-08-25:非产品仓库工具直提 `main`

agent-config 快道扩展并更名为 repository-tooling 快道。除原有
`.pi/`、`.codex/`、`.agents/`、`.omp/` 与 `.scratch/` 外,新增
`.codegraph/`、`.github/`、`.husky/`、根 `.mcp.json`、`skills-lock.json`
以及 delivery harness 的分类与去重脚本及其测试。这些路径不进入
产品运行时或构建产物;只要整个待提交及待推送范围都在文档或
repository-tooling 快道内,就可直接推送 `main` 并跳过 CI。产品集成
脚本、`Makefile`、依赖清单、Desktop、Server 与 `contracts/` 不在此范围。
