import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

type FinalStateResult = {
  decision?: "block";
  reason?: string;
  systemMessage?: string;
};

type FinalStateEvidenceModule = {
  evaluateStop(
    input: { last_assistant_message: string; stop_hook_active: boolean },
    cwd: string,
  ): FinalStateResult;
};

const PRETTIER_PATH = /\.(?:ts|tsx|js|jsx|json|css|yaml)$/;
const GO_PATH = /\.go$/;
const MAIN_PUSH_COMMAND =
  /git\s+push([^;&|]*)(\s+main(\s|$)|:refs\/heads\/main|:main(\s|$))/;

function normalizeToolPath(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/^@/, "").replaceAll("\\", "/");
}

export function isProtectedEditPath(value: unknown): boolean {
  const path = normalizeToolPath(value);
  return path.endsWith("pnpm-lock.yaml") || /\.env(?:\..*)?$/.test(path);
}

export function blockedBashReason(
  command: string,
  branch: string,
): string | undefined {
  if (branch === "main" && /git\s+commit/.test(command)) {
    return "在任务分支完成并验收修改，再使用 make land 快进 main";
  }
  if (MAIN_PUSH_COMMAND.test(command)) {
    return "主干更新必须通过 make land 的 exact-SHA 候选门禁";
  }
  return undefined;
}

async function currentBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
  try {
    const result = await pi.exec("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd,
    });
    return result.code === 0 ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}

async function repositoryRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  try {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
      cwd,
    });
    const root = result.stdout.trim();
    return result.code === 0 && root ? root : cwd;
  } catch {
    return cwd;
  }
}

async function formatChangedPath(
  pi: ExtensionAPI,
  cwd: string,
  rawPath: unknown,
): Promise<void> {
  const path = normalizeToolPath(rawPath);
  if (!path) return;

  const absolutePath = resolve(cwd, path);
  if (PRETTIER_PATH.test(path)) {
    await pi
      .exec("npx", ["prettier", "--write", absolutePath], { cwd })
      .catch(() => undefined);
  }

  if (GO_PATH.test(path)) {
    const gopath = await pi
      .exec("go", ["env", "GOPATH"], { cwd })
      .catch(() => undefined);
    const firstGopath = gopath?.stdout.trim().split(/\r?\n/)[0];
    if (firstGopath) {
      const goimports = resolve(firstGopath, "bin", "goimports");
      await pi
        .exec(goimports, ["-w", absolutePath], { cwd })
        .catch(() => undefined);
    }
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is { type: "text"; text: string } => {
      if (!part || typeof part !== "object") return false;
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string";
    })
    .map((part) => part.text)
    .join("\n");
}

function lastAssistantMessage(ctx: {
  sessionManager: {
    getBranch(): Array<{
      type: string;
      message?: { role?: string; content?: unknown };
    }>;
  };
}): string {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type === "message" && entry.message?.role === "assistant") {
      return contentText(entry.message.content);
    }
  }
  return "";
}

async function evaluateFinalState(
  pi: ExtensionAPI,
  cwd: string,
  lastAssistantText: string,
  stopHookActive: boolean,
): Promise<FinalStateResult> {
  const root = await repositoryRoot(pi, cwd);
  const scriptPath = resolve(root, ".codex/hooks/final-state-evidence.mjs");
  if (!existsSync(scriptPath)) return {};

  const moduleUrl = pathToFileURL(scriptPath).href;
  const { evaluateStop } = (await import(
    moduleUrl
  )) as FinalStateEvidenceModule;
  return evaluateStop(
    {
      last_assistant_message: lastAssistantText,
      stop_hook_active: stopHookActive,
    },
    root,
  );
}

export default function (pi: ExtensionAPI) {
  let continuationRequested = false;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      if (!isProtectedEditPath(event.input.path)) return;
      const path = normalizeToolPath(event.input.path);
      if (ctx.hasUI)
        ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
      return {
        block: true,
        reason: "BLOCKED: do not edit lock files or .env files directly",
      };
    }

    if (event.toolName !== "bash") return;
    const command = event.input.command;
    const branch = await currentBranch(pi, ctx.cwd);
    const reason = blockedBashReason(command, branch);
    if (!reason) return;
    if (ctx.hasUI) ctx.ui.notify(`Blocked bash command: ${reason}`, "warning");
    return { block: true, reason };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    if (event.isError || isProtectedEditPath(event.input.path)) return;
    await formatChangedPath(pi, ctx.cwd, event.input.path);
  });

  pi.on("session_start", () => {
    continuationRequested = false;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const stopHookActive = continuationRequested;
    continuationRequested = false;

    let result: FinalStateResult;
    try {
      result = await evaluateFinalState(
        pi,
        ctx.cwd,
        lastAssistantMessage(ctx),
        stopHookActive,
      );
    } catch (error) {
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Final-state evidence check failed: ${message}`, "error");
      }
      return;
    }

    if (result.decision === "block" && result.reason && !stopHookActive) {
      continuationRequested = true;
      if (ctx.hasUI)
        ctx.ui.notify(
          "Final-state evidence incomplete; continuing the task.",
          "warning",
        );
      pi.sendMessage(
        {
          customType: "codex-final-state-evidence",
          content: result.reason,
          display: false,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      return;
    }

    if (result.systemMessage && ctx.hasUI)
      ctx.ui.notify(result.systemMessage, "warning");
  });
}
