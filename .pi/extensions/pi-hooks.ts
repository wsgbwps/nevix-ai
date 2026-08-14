import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

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

export default function registerPiHooks(pi: ExtensionAPI) {
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
}
