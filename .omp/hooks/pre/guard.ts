// 复刻自 .qoder/settings.json 的 Claude hooks,映射为 omp 原生 hooks
// (omp.sh/docs/hooks;位于 .omp/hooks/pre/,启动时自动发现,修改后 /reload 生效):
//   PreToolUse Edit|Write -> tool_call: 禁止直接编辑 pnpm-lock.yaml / .env*
//   PreToolUse Bash       -> tool_call: main 分支禁止 git commit CI 把关路径
// 自检: omp -p '/extensions' 查看加载路径。
// 安全边界:本 hook 只用于减少误操作,是 guardrail,不是 sandbox 或授权系统;
// bash、其他工具、符号链接等仍可能绕过检查。无人值守/不可信任务必须使用 OS、VM 或容器隔离。
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import {
  classifyGitCommitCommands,
  hasGatedPath,
  isProtectedBranch,
  isProtectedEditPath,
  resolveGitCommitCwd,
} from "../lib/policy.mts";

export default function (pi: HookAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // PreToolUse Edit|Write: 禁止改锁文件和 .env
    if (event.toolName === "edit" || event.toolName === "write") {
      const repoRoot = await repositoryRoot(pi, ctx.cwd);
      if (isProtectedEditPath(String(event.input.path ?? ""), repoRoot)) {
        return {
          block: true,
          reason: "BLOCKED: 禁止直接编辑 pnpm-lock.yaml 或 .env 文件",
        };
      }
      return;
    }

    if (event.toolName !== "bash") return;

    // PreToolUse Bash: main 分支禁止提交 CI 把关路径
    const command = String(event.input.command ?? "");
    for (const commit of classifyGitCommitCommands(command)) {
      const gitCwd = resolveGitCommitCwd(ctx.cwd, commit);
      const repoRoot = await repositoryRoot(pi, gitCwd);
      const branchResult = await pi.exec(
        "git",
        ["symbolic-ref", "--short", "HEAD"],
        {
          cwd: gitCwd,
        },
      );
      if (!isProtectedBranch(branchResult.stdout.trim())) continue;

      // --no-renames 让 rename 的旧/新端点各占一行，避免只检查目标路径。
      const staged = await pi.exec(
        "git",
        ["diff", "--cached", "--name-only", "--no-renames"],
        { cwd: gitCwd },
      );
      let changedPaths = staged.stdout;
      if (commit.stagesAll || commit.includesPathspec) {
        const worktree = await pi.exec(
          "git",
          ["diff", "--name-only", "--no-renames"],
          {
            cwd: gitCwd,
          },
        );
        changedPaths += `\n${worktree.stdout}`;
      }
      if (hasGatedPath(changedPaths, repoRoot)) {
        return {
          block: true,
          reason:
            "BLOCKED: main 上禁止直接提交 CI 把关路径(apps/ server/ supabase/ contracts/ scripts/ .github/ 及根构建清单),请切 feature 分支走 PR;docs/ .scratch/ Makefile 与根级文档可直接提交",
        };
      }
    }
  });
}

async function repositoryRoot(pi: HookAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : cwd;
}
