#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const CLASSIFICATIONS = ["desktop", "server", "e2e", "harness"];

function startsWith(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isOneOf(path, values) {
  return values.includes(path);
}

// apps/desktop 下不改变应用运行时行为的路径:文档与根级 markdown、
// 本地测试产物,以及只由 Desktop CI 自己执行的 unit/component 测试。
// 它们不值得为一次 PR 启动整套 E2E 栈(Go server + PostgreSQL + Electron)
// 的 Smoke E2E。
function isDesktopNonRuntimePath(path) {
  if (
    startsWith(path, "apps/desktop/docs") ||
    startsWith(path, "apps/desktop/test-results") ||
    startsWith(path, "apps/desktop/tests/unit") ||
    startsWith(path, "apps/desktop/tests/component")
  ) {
    return true;
  }
  const relative = path.slice("apps/desktop/".length);
  return !relative.includes("/") && relative.endsWith(".md");
}

export function classifyPaths(paths) {
  const selected = Object.fromEntries(
    CLASSIFICATIONS.map((classification) => [classification, false]),
  );
  const unknownPaths = [];

  for (const path of [...new Set(paths)].sort()) {
    const checks = new Set();

    if (startsWith(path, "apps/desktop")) {
      checks.add("desktop");
      if (!isDesktopNonRuntimePath(path)) {
        checks.add("e2e");
      }
    }

    if (startsWith(path, "server")) checks.add("server");
    // identity 与 creation 的服务端与契约变化跑 Server CI（集成套件在
    // server-ci 内联）并触发 E2E（Desktop harness 会拉起真 server）。
    if (
      startsWith(path, "server/internal/identity") ||
      startsWith(path, "server/internal/creation") ||
      isOneOf(path, ["server/go.mod", "server/go.sum"])
    ) {
      checks.add("e2e");
    }
    if (startsWith(path, "server/cmd/server")) checks.add("e2e");

    // deploy 交付资产（公网 Compose/Nginx/证书生命周期）由 harness 内联的
    // deploy-stack 结构测试验证：端口暴露、摘要钉扎、TLS 与流式合同。
    // 不改产品运行时代码，无需产品套件。
    if (startsWith(path, "deploy")) checks.add("harness");

    // contracts 是 Desktop ↔ Server 的 seam:server 契约一致性测试与 Desktop
    // 消费端都依赖它。
    if (startsWith(path, "contracts")) {
      checks.add("server");
      checks.add("e2e");
    }

    // 专用集成 harness 入口随其服务端面一起触发 Server CI。
    if (
      isOneOf(path, [
        "scripts/test-identity-integration.sh",
        "scripts/test-creation-integration.sh",
      ])
    ) {
      checks.add("server");
    }

    // scripts/dev 是本地开发工具（make server 的 TLS 终结与 fake Kapon
    // sidecar 拉起），不进生产、不触产品运行时，与 Makefile 同类只跑
    // harness 内联自检。
    if (startsWith(path, "scripts/dev")) checks.add("harness");

    if (
      isOneOf(path, ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"])
    ) {
      checks.add("desktop");
      checks.add("e2e");
      checks.add("harness");
    }
    if (path === "turbo.json") checks.add("desktop");
    if (isOneOf(path, ["go.work", "go.work.sum"])) {
      checks.add("server");
      checks.add("e2e");
    }

    if (path === ".github/workflows/desktop-ci.yml") checks.add("desktop");
    if (path === ".github/workflows/server-ci.yml") checks.add("server");
    if (path === ".github/workflows/desktop-e2e-ci.yml") checks.add("e2e");
    if (
      startsWith(path, ".codegraph") ||
      startsWith(path, ".agents") ||
      startsWith(path, ".codex") ||
      startsWith(path, ".husky") ||
      startsWith(path, ".omp") ||
      startsWith(path, ".pi") ||
      startsWith(path, ".scratch") ||
      startsWith(path, ".zcode") ||
      startsWith(path, "docs") ||
      isOneOf(path, [
        ".gitignore",
        ".mcp.json",
        "AGENTS.md",
        "CLAUDE.md",
        "CONTEXT-MAP.md",
        "CONTEXT.md",
        "DESIGN.md",
        "Makefile",
        "README.md",
        "skills-lock.json",
        "scripts/.gitkeep",
        "scripts/classify-ci-changes.mjs",
        "scripts/tests/classify-ci-changes.test.mjs",
        "scripts/tests/deploy-stack.test.mjs",
      ])
    ) {
      checks.add("harness");
    }

    if (
      isOneOf(path, [
        ".github/workflows/ci-gate.yml",
        "scripts/classify-ci-changes.mjs",
        "scripts/tests/classify-ci-changes.test.mjs",
        "scripts/post-merge-dedup.mjs",
        "scripts/tests/post-merge-dedup.test.mjs",
      ])
    ) {
      // 交付机器自身改动只跑 harness 内联测试;workflow 语法或测试坏了
      // 会在几秒内显性失败,不需要产品套件验证。
      checks.add("harness");
    }

    if (checks.size === 0) {
      unknownPaths.push(path);
      continue;
    }
    checks.forEach((check) => {
      selected[check] = true;
    });
  }

  return { ...selected, unknownPaths };
}

function git(args, encoding = "utf8") {
  const result = spawnSync("git", args, { encoding });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout).trim());
  }
  return result.stdout;
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--base", "--head", "--github-output"].includes(flag) || !value) {
      throw new Error(
        "usage: classify-ci-changes.mjs --base <sha> --head <sha> [--github-output <path>]",
      );
    }
    values[flag.slice(2)] = value;
  }
  if (!values.base || !values.head) {
    throw new Error("--base and --head are required");
  }
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  git(["diff", "--check", `${args.base}...${args.head}`]);
  const paths = git(
    [
      "diff",
      "--no-renames",
      "--diff-filter=d",
      "--name-only",
      "-z",
      `${args.base}...${args.head}`,
    ],
    null,
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const result = classifyPaths(paths);

  if (result.unknownPaths.length > 0) {
    throw new Error(
      `unclassified changed paths: ${result.unknownPaths.join(", ")}`,
    );
  }

  if (args["github-output"]) {
    appendFileSync(
      args["github-output"],
      `${CLASSIFICATIONS.map(
        (classification) => `${classification}=${result[classification]}`,
      ).join("\n")}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify({ paths, ...result }, null, 2)}\n`);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
