import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

const PRETTIER_PATH = /\.(?:ts|tsx|js|jsx|json|css|yaml)$/;
const GO_PATH = /\.go$/;
const MAIN_PUSH_COMMAND =
  /git\s+push([^;&|]*)(\s+main(\s|$)|:refs\/heads\/main|:main(\s|$))/;

const FAST_LANE_PATH =
  /^(\.(?:pi|codex|agents|omp|scratch)\/|docs\/|(?:apps\/desktop|server)\/AGENTS\.md$|[^/]+\.md$)/;
const FAST_LANE_NOTE =
  "（仅 agent 配置与文档改动可直提直推）";

export function isFastLanePath(path: string): boolean {
  return FAST_LANE_PATH.test(path);
}

function fastLaneOnly(paths: string[] | undefined): boolean {
  // 未提供路径信息时按非白名单处理（fail-safe）
  return paths !== undefined && paths.every(isFastLanePath);
}
function normalizeToolPath(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/^@/, "").replaceAll("\\", "/");
}

export function isProtectedEditPath(value: unknown): boolean {
  const path = normalizeToolPath(value);
  if (path.endsWith("pnpm-lock.yaml")) return true;
  // `.env.example` 类模板是供人复制的文档（server/.env.example、
  // supabase/auth-policy.env.example），不承载机密，保持可编辑；
  // 真实 dotenv 文件（.env、.env.local、.env.production、*.env）仍被拦截。
  if (path.endsWith(".env.example")) return false;
  return /\.env(?:\.[^/]*)?$/.test(path);
}

export function blockedBashReason(
  command: string,
  branch: string,
  trackedPaths?: string[],
  pushedPaths?: string[],
): string | undefined {
  if (
    branch === "main" &&
    /git\s+commit/.test(command) &&
    !fastLaneOnly(trackedPaths)
  ) {
    return "在任务分支完成修改并开 PR,不要直接在 main 上提交" + FAST_LANE_NOTE;
  }
  if (MAIN_PUSH_COMMAND.test(command) && !fastLaneOnly(pushedPaths)) {
    return "main 通过 PR squash merge 更新,不要直接 push main" + FAST_LANE_NOTE;
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

async function gitOutput(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
): Promise<string[]> {
  try {
    const result = await pi.exec("git", args, { cwd });
    if (result.code !== 0) return [];
    return result.stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function parseStatusPaths(lines: string[]): string[] {
  const paths: string[] = [];
  for (const line of lines) {
    if (line.startsWith("??")) continue;
    const raw = line.slice(3);
    for (const part of raw.split(" -> ")) {
      const path = part.trim().replace(/^\"|\"$/g, "");
      if (path) paths.push(path);
    }
  }
  return paths;
}

async function trackedChangePaths(pi: ExtensionAPI, cwd: string) {
  return parseStatusPaths(await gitOutput(pi, cwd, ["status", "--porcelain"]));
}

async function pushedChangePaths(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string[] | undefined> {
  const base = await pi
    .exec("git", ["rev-parse", "origin/main"], { cwd })
    .catch(() => undefined);
  if (!base || base.code !== 0) return undefined;
  const diff = await pi
    .exec(
      "git",
      ["diff", "--no-renames", "--name-only", `${base.stdout.trim()}..HEAD`],
      { cwd },
    )
    .catch(() => undefined);
  if (!diff || diff.code !== 0) return undefined;
  return diff.stdout.split(/\r?\n/).filter(Boolean);
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
    const needsTrackedPaths = branch === "main" && /git\s+commit/.test(command);
    const needsPushedPaths = MAIN_PUSH_COMMAND.test(command);
    const reason = blockedBashReason(
      command,
      branch,
      needsTrackedPaths ? await trackedChangePaths(pi, ctx.cwd) : undefined,
      needsPushedPaths ? await pushedChangePaths(pi, ctx.cwd) : undefined,
    );
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
