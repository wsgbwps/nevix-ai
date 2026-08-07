// 移植自 .qoder/settings.json 的 Claude hooks,映射为 omp 原生 hooks
// (omp.sh/docs/hooks;位于 .omp/hooks/post/,启动时自动发现,修改后 /reload 生效):
//   PostToolUse Edit|Write -> tool_result: prettier --write (ts/tsx/js/jsx/json/css/yaml)
//   PostToolUse Edit|Write -> tool_result: goimports -w (go)
// Prettier、go env 或 goimports 失败时,错误追加到原 tool result,模型和用户都能看到。
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { resolve } from "node:path";
import { canonicalizeRepoPath } from "../lib/policy.mts";

const PRETTIER_EXTS = /\.(ts|tsx|js|jsx|json|css|yaml)$/;

export default function (pi: HookAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
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

async function repositoryRoot(pi: HookAPI, cwd: string): Promise<string> {
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
