// 移植自 .qoder/settings.json 的 Claude hooks,映射为 Pi 原生扩展事件:
//   1. UserPromptSubmit  -> input (transform): 运行 codegraph prompt-hook,注入结构化上下文
//   2. PreToolUse Edit|Write -> tool_call: 禁止直接编辑 pnpm-lock.yaml / .env*
//   3. PreToolUse Bash       -> tool_call: main 分支禁止 git commit CI 把关路径
//   4. PostToolUse Edit|Write -> tool_result: prettier --write (ts/js/json/css/yaml)
//   5. PostToolUse Edit|Write -> tool_result: goimports -w (go)
// 修改后 /reload 生效。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isToolCallEventType, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

/** 执行命令并通过 stdin 传入数据(codegraph prompt-hook 需要),返回 stdout */
function runWithInput(
  cmd: string,
  args: string[],
  input: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
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

  // ---------- 1. UserPromptSubmit -> codegraph prompt-hook ----------
  pi.on("input", async (event, ctx) => {
    // 跳过扩展注入的消息和斜杠命令(/reload、/skill:...),避免污染
    if (event.source === "extension") return { action: "continue" };
    if (event.text.startsWith("/")) return { action: "continue" };

    try {
      const context = await runWithInput(
        "codegraph",
        ["prompt-hook"],
        JSON.stringify({ prompt: event.text, cwd: ctx.cwd }),
        { cwd: ctx.cwd, timeoutMs: 15_000 },
      );
      if (!context.trim()) return { action: "continue" };
      // 与 Claude UserPromptSubmit 语义一致:上下文拼进用户 prompt
      return { action: "transform", text: event.text + "\n\n" + context.trim() };
    } catch {
      return { action: "continue" }; // 失败静默降级,不阻塞用户输入
    }
  });

  // ---------- 2/3. PreToolUse ----------
  const GATED_PATHS =
    /^(apps\/|server\/|supabase\/|contracts\/|scripts\/|\.github\/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|go\.work)/;

  pi.on("tool_call", async (event, ctx) => {
    // PreToolUse Edit|Write: 禁止改锁文件和 .env
    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      const fp = event.input.path;
      if (/(^|\/)pnpm-lock\.yaml$/.test(fp) || /(^|\/)\.env($|\.)/.test(fp)) {
        return { block: true, reason: "BLOCKED: 禁止直接编辑 pnpm-lock.yaml 或 .env 文件" };
      }
      return;
    }

    // PreToolUse Bash: main 分支禁止提交 CI 把关路径
    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;
      if (!/\bgit\s+commit\b/.test(cmd)) return;

      const branch = (await pi.exec("git", ["symbolic-ref", "--short", "HEAD"], { cwd: ctx.cwd })).stdout.trim();
      if (branch !== "main") return;

      const isAll = /(\s--all(\s|$)|(\s-[a-zA-Z]*a))/.test(cmd);
      const { stdout: staged } = await pi.exec("git", ["diff", "--cached", "--name-only"], { cwd: ctx.cwd });
      let files = staged;
      if (isAll) {
        const { stdout: worktree } = await pi.exec("git", ["diff", "--name-only"], { cwd: ctx.cwd });
        files += "\n" + worktree;
      }
      if (GATED_PATHS.test(files)) {
        return {
          block: true,
          reason:
            "BLOCKED: main 上禁止直接提交 CI 把关路径(apps/ server/ supabase/ contracts/ scripts/ .github/ 及根构建清单),请切 feature 分支走 PR;docs/ .scratch/ Makefile 与根级文档可直接提交",
        };
      }
      return;
    }
  });

  // ---------- 4/5. PostToolUse: prettier / goimports ----------
  const PRETTIER_EXTS = /\.(ts|tsx|js|jsx|json|css|yaml)$/;

  pi.on("tool_result", async (event, ctx) => {
    if (!isEditToolResult(event) && !isWriteToolResult(event)) return;
    const fp = String(event.input.path ?? "");
    if (PRETTIER_EXTS.test(fp)) {
      try {
        await pi.exec("npx", ["prettier", "--write", fp], { cwd: ctx.cwd, timeout: 60_000 });
      } catch {
        // 与原来 || true 一致:格式化失败不阻断
      }
    } else if (fp.endsWith(".go")) {
      try {
        const gopath = (await pi.exec("go", ["env", "GOPATH"], { cwd: ctx.cwd })).stdout.trim();
        await pi.exec(`${gopath}/bin/goimports`, ["-w", fp], { cwd: ctx.cwd, timeout: 30_000 });
      } catch {
        // goimports 未安装时静默
      }
    }
  });
}
