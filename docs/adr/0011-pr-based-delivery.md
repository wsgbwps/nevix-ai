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
