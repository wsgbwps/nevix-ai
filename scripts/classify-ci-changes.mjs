#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const CLASSIFICATIONS = [
  "desktop",
  "server",
  "windows_native",
  "macos_native",
  "harness",
];

function startsWith(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isOneOf(path, values) {
  return values.includes(path);
}

// apps/desktop 下不改变应用运行时行为的路径：文档与根级 markdown、
// 本地测试产物，以及已由 Linux Desktop CI 执行的 unit/component 测试。
// 这些路径不启动平台 Native Smoke。
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

function isMacOSNativePath(path) {
  return (
    startsWith(path, "apps/desktop/src/main") ||
    startsWith(path, "apps/desktop/src/preload") ||
    startsWith(path, "apps/desktop/src/shared") ||
    startsWith(path, "apps/desktop/build") ||
    startsWith(path, "apps/desktop/tests/window") ||
    isOneOf(path, [
      "apps/desktop/electron-builder.yml",
      "apps/desktop/electron.vite.config.ts",
      "apps/desktop/package.json",
      "apps/desktop/playwright.config.ts",
      "apps/desktop/scripts/run-native-smoke.mjs",
      "apps/desktop/tests/auth/native-secure-persistence.spec.ts",
      "apps/desktop/tests/helpers/electron-app.ts",
      "apps/desktop/tests/startup/renderer-readiness.spec.ts",
    ])
  );
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
        checks.add("windows_native");
        if (isMacOSNativePath(path)) checks.add("macos_native");
      }
    }

    if (startsWith(path, "server")) checks.add("server");

    // deploy 交付资产（公网 Compose/Nginx/证书生命周期）由 harness 内联的
    // deploy-stack 结构测试验证：端口暴露、摘要钉扎、TLS 与流式合同。
    // 不改产品运行时代码，无需产品套件。
    if (startsWith(path, "deploy")) checks.add("harness");

    // contracts 的自动门禁由 Server CI 拥有；跨层验收留给本地 Full E2E。
    if (startsWith(path, "contracts")) checks.add("server");

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
      checks.add("windows_native");
      checks.add("macos_native");
      checks.add("harness");
    }
    if (path === "turbo.json") checks.add("desktop");
    if (isOneOf(path, ["go.work", "go.work.sum"])) checks.add("server");

    if (path === ".github/workflows/desktop-ci.yml") checks.add("desktop");
    if (path === ".github/workflows/server-ci.yml") checks.add("server");
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
