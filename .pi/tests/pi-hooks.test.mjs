import assert from "node:assert/strict";
import test from "node:test";

import registerPiHooks, {
  blockedBashReason,
  isProtectedEditPath,
} from "../extensions/pi-hooks.ts";

test("protects lock files and environment files", () => {
  for (const path of [
    "pnpm-lock.yaml",
    "apps/desktop/pnpm-lock.yaml",
    ".env",
    ".env.local",
    "config.env.example",
    "@server\\.env.test",
  ]) {
    assert.equal(isProtectedEditPath(path), true, path);
  }

  for (const path of [
    "package.json",
    "pnpm-lock.yml",
    ".envexample",
    "src/config.ts",
  ]) {
    assert.equal(isProtectedEditPath(path), false, path);
  }
});

test("blocks commits on main and pushes to main", () => {
  assert.match(
    blockedBashReason("git commit -am 'change'", "main") ?? "",
    /任务分支/,
  );
  assert.equal(
    blockedBashReason("git commit -am 'change'", "feature/task"),
    undefined,
  );
  assert.match(
    blockedBashReason("git push origin main", "feature/task") ?? "",
    /PR squash merge/,
  );
  assert.match(
    blockedBashReason("git push origin :refs/heads/main", "feature/task") ?? "",
    /直接 push main/,
  );
  assert.equal(
    blockedBashReason("git push origin feature/task", "feature/task"),
    undefined,
  );
});

test("agent-config fast lane allows direct main commit and push", () => {
  // 未提供路径（信息不可得）时 fail-safe 拦截
  assert.match(blockedBashReason("git commit -m x", "main") ?? "", /任务分支/);
  assert.match(
    blockedBashReason("git push origin main", "main") ?? "",
    /直接 push main/,
  );

  // 白名单内的已跟踪改动:允许在 main 上提交
  assert.equal(
    blockedBashReason("git commit -m 'tweak skill'", "main", [
      ".agents/skills/implement/SKILL.md",
      ".scratch/note.md",
    ]),
    undefined,
  );

  // 混入白名单外路径:拦截
  assert.match(
    blockedBashReason("git commit -m x", "main", [
      ".pi/extensions/pi-hooks.ts",
      "server/main.go",
    ]) ?? "",
    /任务分支/,
  );

  // 待推送 diff 全在白名单:允许直推 main;混入业务代码则拦截
  assert.equal(
    blockedBashReason("git push origin main", "main", undefined, [
      ".omp/agents/researcher.md",
    ]),
    undefined,
  );
  assert.match(
    blockedBashReason("git push origin main", "main", undefined, [
      ".codex/hooks.json",
      "apps/desktop/src/main/index.ts",
    ]) ?? "",
    /直接 push main/,
  );

  // git 不可用(undefined)时拦截直推
  assert.match(
    blockedBashReason("git push origin main", "main", undefined, undefined) ?? "",
    /直接 push main/,
  );
});

test("registers Pi tool hooks and formats only successful unprotected edits", async () => {
  const handlers = new Map();
  const calls = [];
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    exec: async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: "main\n", stderr: "" };
    },
    sendMessage() {},
  };
  registerPiHooks(pi);

  assert.deepEqual(
    [...handlers.keys()],
    ["tool_call", "tool_result"],
  );

  const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify() {} } };
  const toolCall = handlers.get("tool_call");
  const toolResult = handlers.get("tool_result");
  const protectedEdit = await toolCall(
    { toolName: "edit", input: { path: ".env" } },
    ctx,
  );
  assert.equal(protectedEdit?.block, true);
  assert.equal(
    await toolCall({ toolName: "edit", input: { path: "src/app.ts" } }, ctx),
    undefined,
  );

  calls.length = 0;
  await toolResult(
    { toolName: "edit", input: { path: "src/app.ts" }, isError: false },
    ctx,
  );
  assert.equal(calls[0]?.command, "npx");
  assert.deepEqual(calls[0]?.args.slice(0, 3), [
    "prettier",
    "--write",
    `${process.cwd()}/src/app.ts`,
  ]);

  calls.length = 0;
  await toolResult(
    { toolName: "write", input: { path: "pnpm-lock.yaml" }, isError: false },
    ctx,
  );
  await toolResult(
    { toolName: "write", input: { path: "src/app.ts" }, isError: true },
    ctx,
  );
  assert.equal(calls.length, 0);
});
