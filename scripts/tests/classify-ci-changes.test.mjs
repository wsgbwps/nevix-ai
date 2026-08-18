import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { classifyPaths } from "../classify-ci-changes.mjs";

const REPOSITORY = join(import.meta.dirname, "../..");

function selected(paths) {
  const result = classifyPaths(paths);
  return Object.fromEntries(
    Object.entries(result).filter(
      ([key, value]) => key !== "unknownPaths" && value,
    ),
  );
}

test("Desktop pages require Desktop CI and Full E2E", () => {
  assert.deepEqual(
    selected(["apps/desktop/src/renderer/src/app/pages/settings.tsx"]),
    { desktop: true, e2e: true },
  );
});

test("ordinary Go packages require only Server CI", () => {
  assert.deepEqual(selected(["server/internal/event/bus.go"]), {
    server: true,
  });
});

test("Identity server changes require every cross-runtime check", () => {
  assert.deepEqual(
    selected(["server/internal/identity/invitations/accept.go"]),
    { server: true, identity: true, e2e: true },
  );
});

test("root JavaScript manifests cover product and harness consumers", () => {
  assert.deepEqual(selected(["package.json"]), {
    desktop: true,
    identity: true,
    e2e: true,
    harness: true,
  });
});

test("agent and delivery documentation requires inline harness validation", () => {
  assert.deepEqual(
    selected(["AGENTS.md", "docs/adr/0011-pr-based-delivery.md"]),
    { harness: true },
  );
});

test("Pi agent definitions, extension code, and tests require inline harness validation", () => {
  assert.deepEqual(
    selected([
      ".pi/agents/reviewer.md",
      ".pi/extensions/pi-hooks.ts",
      ".pi/tests/pi-hooks.test.mjs",
    ]),
    { harness: true },
  );
});

test("delivery-harness changes run only the inline harness tests", () => {
  assert.deepEqual(selected(["scripts/classify-ci-changes.mjs"]), {
    harness: true,
  });
  assert.deepEqual(selected([".github/workflows/ci-gate.yml"]), {
    harness: true,
  });
});

test("unknown paths fail closed", () => {
  assert.deepEqual(classifyPaths(["new-runtime/module.ts"]).unknownPaths, [
    "new-runtime/module.ts",
  ]);
});

test("the classifier excludes deleted paths before classification", () => {
  const main = readFileSync(
    join(REPOSITORY, "scripts/classify-ci-changes.mjs"),
    "utf8",
  );

  assert.match(main, /--diff-filter=d/);
});

test("the CI gate runs harness tests inline without a separate job", () => {
  const workflow = readFileSync(
    join(REPOSITORY, ".github/workflows/ci-gate.yml"),
    "utf8",
  );

  assert.match(
    workflow,
    /if: steps\.classify\.outputs\.harness == 'true'[\s\S]*run: make harness-test/,
  );
  assert.doesNotMatch(workflow, /harness-ci\.yml|\n  harness:\n/);
  assert.doesNotMatch(workflow, /HARNESS_(?:REQUIRED|RESULT)/);
});

test("every existing repository path has an explicit check owner", () => {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter((path) => path && existsSync(join(REPOSITORY, path)));

  assert.deepEqual(classifyPaths(paths).unknownPaths, []);
});
