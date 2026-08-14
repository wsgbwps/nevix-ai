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
    /exact-SHA/,
  );
  assert.match(
    blockedBashReason("git push origin :refs/heads/main", "feature/task") ?? "",
    /主干更新/,
  );
  assert.equal(
    blockedBashReason("git push origin feature/task", "feature/task"),
    undefined,
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
