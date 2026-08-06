// 移植自 .qoder/settings.json 的 Claude hooks,映射为 Pi 原生扩展事件:
//   1. UserPromptSubmit  -> input (transform): codegraph prompt-hook 注入已默认关闭(P0.4),
//      仅当 CODEGRAPH_PROMPT_INJECT=1 且满足全部护栏时运行,详见 repo-hooks/prompt-inject.mts
//   2. PreToolUse Edit|Write -> tool_call: 禁止直接编辑 pnpm-lock.yaml / .env*
//   3. PreToolUse Bash       -> tool_call: main 分支禁止 git commit CI 把关路径
//   4. PostToolUse Edit|Write -> tool_result: prettier --write (ts/js/json/css/yaml)
//   5. PostToolUse Edit|Write -> tool_result: goimports -w (go)
// 修改后 /reload 生效。
// 安全边界:本扩展只用于减少误操作,是 guardrail,不是 sandbox 或授权系统;
// bash、其他工具、符号链接等仍可能绕过检查。无人值守/不可信任务必须使用 OS、VM 或容器隔离。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isEditToolResult,
  isToolCallEventType,
  isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  DEFAULT_MAX_INJECT_BYTES,
  applyByteLimit,
  appendInjectLog,
  classifyHookOutput,
  shouldRunHook,
} from "./repo-hooks/prompt-inject.mts";
import {
  canonicalizeRepoPath,
  classifyGitCommitCommands,
  dangerousCommandDecision,
  hasGatedPath,
  isProtectedBranch,
  isProtectedEditPath,
  resolveGitCommitCwd,
} from "./repo-hooks/policy.mts";

// P0.4 降低无关上下文:codegraph prompt-hook 无条件输入注入默认关闭,保留
// on-demand codegraph_explore 工具(.mcp.json 已配置)。显式开启:
//   CODEGRAPH_PROMPT_INJECT=1 [CODEGRAPH_PROMPT_INJECT_MAX_BYTES=8000]
const codegraphInjectEnabled = process.env.CODEGRAPH_PROMPT_INJECT === "1";
const codegraphInjectMaxBytes = Number(
  process.env.CODEGRAPH_PROMPT_INJECT_MAX_BYTES ?? DEFAULT_MAX_INJECT_BYTES,
);

/** 执行命令并通过 stdin 传入数据(codegraph prompt-hook 需要),返回 stdout */
function runWithInput(
  cmd: string,
  args: string[],
  input: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout after ${opts.timeoutMs}ms: ${cmd}`));
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 300)}`));
    });
    child.stdin.end(input);
  });
}

export default function (pi: ExtensionAPI) {
  // 自检命令:reload 后执行 /hook-status 可确认本扩展已加载
  pi.registerCommand("hook-status", {
    description: "Show repo-hooks extension load status",
    handler: async (_args, ctx) => {
      await ctx.ui.notify(
        "repo-hooks extension is loaded: input(transform), tool_call(block), tool_result(format)",
        "info",
      );
    },
  });

  // ---------- 1. UserPromptSubmit -> codegraph prompt-hook(默认关闭,P0.4) ----------
  pi.on("input", async (event, ctx) => {
    // 默认关闭无条件注入;开启时也仅处理 idle 初始 prompt,护栏见 prompt-inject.mts
    if (!codegraphInjectEnabled) return { action: "continue" };

    const logPath = resolve(ctx.cwd, ".pi", "logs", "codegraph-inject.jsonl");
    const sessionId = ctx.sessionManager.getSessionId();
    const entries = ctx.sessionManager.getEntries();
    // 只处理 idle 初始 prompt:会话中尚无任何 message 条目
    const gate = shouldRunHook({
      source: event.source,
      text: event.text,
      streamingBehavior: event.streamingBehavior,
      isFirstUserMessage: !entries.some((entry) => entry.type === "message"),
    });
    if (!gate.run) {
      void appendInjectLog(logPath, {
        ts: new Date().toISOString(),
        sessionId,
        gate: "skipped",
        skipReasons: gate.skipReasons,
      });
      return { action: "continue" };
    }

    const started = performance.now();
    try {
      const context = await runWithInput(
        "codegraph",
        ["prompt-hook"],
        JSON.stringify({ prompt: event.text, cwd: ctx.cwd }),
        { cwd: ctx.cwd, timeoutMs: 15_000 },
      );
      const elapsedMs = Math.round(performance.now() - started);
      const outcome = classifyHookOutput(context);
      const bytes = Buffer.byteLength(context, "utf8");
      // 无高置信 relevance 不注入:只有真实返回源码的 high 结果才拼进 prompt;
      // 符号列表(medium)/子项目提示(nudge)/空结果(empty)一律跳过
      if (outcome !== "high") {
        void appendInjectLog(logPath, {
          ts: new Date().toISOString(),
          sessionId,
          gate: "ran",
          outcome,
          bytes,
          elapsedMs,
        });
        return { action: "continue" };
      }
      const limited = applyByteLimit(context, codegraphInjectMaxBytes);
      void appendInjectLog(logPath, {
        ts: new Date().toISOString(),
        sessionId,
        gate: "ran",
        outcome,
        bytes,
        injectedBytes: Buffer.byteLength(limited.text, "utf8"),
        truncated: limited.truncated,
        elapsedMs,
      });
      // 与 Claude UserPromptSubmit 语义一致:上下文拼进用户 prompt
      return {
        action: "transform",
        text: event.text + "\n\n" + limited.text.trim(),
      };
    } catch (error) {
      void appendInjectLog(logPath, {
        ts: new Date().toISOString(),
        sessionId,
        gate: "ran",
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Math.round(performance.now() - started),
      });
      return { action: "continue" }; // 失败静默降级,不阻塞用户输入
    }
  });

  // ---------- 2/3. PreToolUse ----------
  pi.on("tool_call", async (event, ctx) => {
    // PreToolUse Edit|Write: 禁止改锁文件和 .env
    if (
      isToolCallEventType("edit", event) ||
      isToolCallEventType("write", event)
    ) {
      const repoRoot = await repositoryRoot(pi, ctx.cwd);
      if (isProtectedEditPath(event.input.path, repoRoot)) {
        return {
          block: true,
          reason: "BLOCKED: 禁止直接编辑 pnpm-lock.yaml 或 .env 文件",
        };
      }
      return;
    }

    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    const dangerousDecision = dangerousCommandDecision(command, ctx.mode);
    if (dangerousDecision === "block") {
      return {
        block: true,
        reason: "BLOCKED: non-TUI 模式默认拒绝需要人工确认的危险命令",
      };
    }
    if (dangerousDecision === "confirm") {
      const confirmed = await ctx.ui.confirm(
        "危险命令",
        `${command}\n\nrepo-hooks 只是 guardrail；确认执行？`,
      );
      if (!confirmed)
        return { block: true, reason: "BLOCKED: 用户拒绝危险命令" };
    }

    // PreToolUse Bash: main 分支禁止提交 CI 把关路径
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

  // ---------- 4/5. PostToolUse: prettier / goimports ----------
  const PRETTIER_EXTS = /\.(ts|tsx|js|jsx|json|css|yaml)$/;

  pi.on("tool_result", async (event, ctx) => {
    if (!isEditToolResult(event) && !isWriteToolResult(event)) return;
    const fp = String(event.input.path ?? "");
    if (!PRETTIER_EXTS.test(fp) && !fp.endsWith(".go")) return;

    const repoRoot = await repositoryRoot(pi, ctx.cwd);
    const repoPath = canonicalizeRepoPath(fp, repoRoot);
    const absolutePath = resolve(ctx.cwd, fp);

    if (PRETTIER_EXTS.test(fp)) {
      const result = await pi.exec(
        "pnpm",
        ["exec", "prettier", "--write", absolutePath],
        {
          cwd: repoRoot,
          timeout: 60_000,
        },
      );
      if (result.code !== 0 || result.killed) {
        return visibleFormatterFailure(
          event.content,
          `pnpm exec prettier --write ${repoPath ?? fp}`,
          result,
        );
      }
    } else {
      const goEnv = await pi.exec("go", ["env", "GOPATH"], { cwd: repoRoot });
      if (goEnv.code !== 0 || goEnv.killed) {
        return visibleFormatterFailure(event.content, "go env GOPATH", goEnv);
      }
      const goimports = resolve(goEnv.stdout.trim(), "bin", "goimports");
      const result = await pi.exec(goimports, ["-w", absolutePath], {
        cwd: repoRoot,
        timeout: 30_000,
      });
      if (result.code !== 0 || result.killed) {
        return visibleFormatterFailure(
          event.content,
          `${goimports} -w ${repoPath ?? fp}`,
          result,
        );
      }
    }
  });
}

async function repositoryRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : cwd;
}

function visibleFormatterFailure<T extends { type: string }>(
  content: T[],
  command: string,
  result: { code: number; killed: boolean; stdout: string; stderr: string },
) {
  const detail = (result.stderr || result.stdout || "no output")
    .trim()
    .slice(0, 500);
  const status = result.killed ? "killed" : `exit ${result.code}`;
  return {
    content: [
      ...content,
      {
        type: "text" as const,
        text: `repo-hooks formatter failed (${status}): ${command}\n${detail}`,
      },
    ],
  };
}
