# Repo hooks policy

`../repo-hooks.ts` 是仓库开发流程的 **guardrail**：它降低误改敏感文件、在 `main` 直接提交 CI 把关路径、以及无确认执行危险命令的概率。

它**不是 sandbox、安全边界或授权系统**。`bash`、其他 Extension/MCP 工具、符号链接或别名路径仍可能绕过基于路径和命令字符串的判断；Extension 本身也拥有启动 Pi 的用户权限。无人值守或不可信任务必须使用 OS 权限、VM 或容器提供真正隔离。

## Policy behavior

- `edit`/`write` 的绝对和相对路径先规范为仓库相对路径，再拦截 `pnpm-lock.yaml` 与 `.env*`。
- `main` 上的 `git commit`（包括 `cd ... && git -C ... commit`）逐行检查 changed paths。`--no-renames` 让 rename 的旧、新端点都参与检查；`--all`/`-a` 和 direct pathspec commit 还会检查 tracked worktree changes。
- `rm -r`、`sudo`、`chmod/chown ... 777` 在 TUI 中需要确认，在 RPC/JSON/print 模式默认拒绝。
- Prettier 通过仓库本地的 `pnpm exec prettier` 运行；Prettier、`go env` 或 `goimports` 失败时，错误会追加到原 tool result，模型和用户都能看到。

这些规则的 deterministic 部分位于 `policy.mts`，不依赖 Pi runtime。

## Test

```bash
node --test .pi/extensions/repo-hooks/policy.test.mts
```
