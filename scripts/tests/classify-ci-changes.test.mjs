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

test("Renderer-only runtime changes add Windows Native Smoke", () => {
  assert.deepEqual(
    selected(["apps/desktop/src/renderer/src/app/pages/settings.tsx"]),
    { desktop: true, windows_native: true },
  );
});

test("native-sensitive Desktop paths add macOS Native Smoke", () => {
  assert.deepEqual(
    selected([
      "apps/desktop/src/main/window/main-window.ts",
      "apps/desktop/src/preload/index.ts",
      "apps/desktop/src/shared/ipc/channels.ts",
      "apps/desktop/build/entitlements.mac.plist",
      "apps/desktop/electron-builder.yml",
      "apps/desktop/package.json",
    ]),
    { desktop: true, windows_native: true, macos_native: true },
  );
});

test("Desktop documentation and local artifacts stay out of Native Smoke", () => {
  assert.deepEqual(
    selected([
      "apps/desktop/README.md",
      "apps/desktop/CONTEXT.md",
      "apps/desktop/AGENTS.md",
      "apps/desktop/docs/adr/0004-renderer-routing-topology.md",
      "apps/desktop/test-results/.last-run.json",
    ]),
    { desktop: true },
  );
});

test("Desktop unit and component tests run only inside Desktop CI", () => {
  assert.deepEqual(
    selected([
      "apps/desktop/tests/unit/startup-resolution.test.mts",
      "apps/desktop/tests/component/authentication-transition.spec.tsx",
    ]),
    { desktop: true },
  );
});

test("ordinary E2E specs add only Windows Native Smoke", () => {
  assert.deepEqual(
    selected(["apps/desktop/tests/auth/session-persistence.spec.ts"]),
    { desktop: true, windows_native: true },
  );
});

test("Native Smoke infrastructure adds both platform lanes", () => {
  assert.deepEqual(
    selected([
      "apps/desktop/scripts/run-native-smoke.mjs",
      "apps/desktop/tests/auth/native-secure-persistence.spec.ts",
      "apps/desktop/tests/helpers/electron-app.ts",
      "apps/desktop/tests/window/native-editing.spec.ts",
    ]),
    { desktop: true, windows_native: true, macos_native: true },
  );
});

test("ordinary Go packages require only Server CI", () => {
  assert.deepEqual(selected(["server/internal/event/bus.go"]), {
    server: true,
  });
});

test("Identity server changes require only Server CI", () => {
  assert.deepEqual(selected(["server/internal/identity/auth/sessions.go"]), {
    server: true,
  });
});

test("Creation module changes require only Server CI", () => {
  assert.deepEqual(selected(["server/internal/creation/module.go"]), {
    server: true,
  });
  assert.deepEqual(
    selected(["server/internal/creation/integrationtest/harness_test.go"]),
    { server: true },
  );
});

test("the Creation storage contract triggers only Server CI", () => {
  assert.deepEqual(selected(["contracts/creation.yaml"]), {
    server: true,
  });
});

test("API contracts require only Server CI", () => {
  assert.deepEqual(selected(["contracts/identity.yaml"]), { server: true });
});

test("the server integration harness entry runs Server CI", () => {
  assert.deepEqual(selected(["scripts/test-identity-integration.sh"]), {
    server: true,
  });
  assert.deepEqual(selected(["scripts/test-creation-integration.sh"]), {
    server: true,
  });
});

test("root JavaScript manifests cover product and harness consumers", () => {
  assert.deepEqual(selected(["package.json"]), {
    desktop: true,
    windows_native: true,
    macos_native: true,
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

test("ZCode workspace configuration requires inline harness validation", () => {
  assert.deepEqual(selected([".zcode/config.json"]), { harness: true });
});

test("delivery-harness changes run only the inline harness tests", () => {
  assert.deepEqual(
    selected([
      "scripts/classify-ci-changes.mjs",
      "scripts/tests/classify-ci-changes.test.mjs",
      "scripts/post-merge-dedup.mjs",
      "scripts/tests/post-merge-dedup.test.mjs",
    ]),
    { harness: true },
  );
  assert.deepEqual(selected([".github/workflows/ci-gate.yml"]), {
    harness: true,
  });
});

test("deploy delivery assets run only the inline harness tests", () => {
  assert.deepEqual(
    selected([
      "deploy/docker-compose.yml",
      "deploy/nginx/nginx.conf",
      "deploy/cert-init/cert-init.sh",
      "deploy/README.md",
      "scripts/tests/deploy-stack.test.mjs",
    ]),
    { harness: true },
  );
});

test("local dev tooling under scripts/dev runs only the inline harness tests", () => {
  assert.deepEqual(
    selected([
      "scripts/dev/dev-server.sh",
      "scripts/dev/fake-kapon.mjs",
      "scripts/dev/README.md",
    ]),
    { harness: true },
  );
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

test("main pushes containing only fast-lane paths skip the CI workflow", () => {
  const workflow = readFileSync(
    join(REPOSITORY, ".github/workflows/ci-gate.yml"),
    "utf8",
  );

  assert.match(workflow, /- "\*\*\/\*\.md"/);
  assert.match(workflow, /- "\*\*\/docs\/\*\*"/);
  for (const fastLanePath of [
    ".codegraph/**",
    ".pi/**",
    ".github/**",
    ".husky/**",
    ".zcode/**",
    ".mcp.json",
    "skills-lock.json",
    "scripts/classify-ci-changes.mjs",
    "scripts/tests/classify-ci-changes.test.mjs",
    "scripts/post-merge-dedup.mjs",
    "scripts/tests/post-merge-dedup.test.mjs",
  ]) {
    assert.match(
      workflow,
      new RegExp(
        `- "${fastLanePath.replaceAll(".", "\\.").replaceAll("*", "\\*")}"`,
      ),
    );
  }
});

test("the pre-push hook allows only documentation and repository tooling", () => {
  const hook = readFileSync(join(REPOSITORY, ".husky/pre-push"), "utf8");
  const pattern = hook.match(/grep -qvE '([^']+)'/)?.[1];
  assert.ok(pattern, "pre-push fast-lane pattern is missing");

  const isFastLanePath = (candidate) => new RegExp(pattern).test(candidate);
  for (const candidate of [
    "README.md",
    "apps/desktop/docs/guide.png",
    ".pi/extensions/pi-hooks.ts",
    ".github/workflows/ci-gate.yml",
    ".husky/pre-push",
    ".zcode/config.json",
    ".mcp.json",
    "skills-lock.json",
    "scripts/classify-ci-changes.mjs",
    "scripts/tests/post-merge-dedup.test.mjs",
  ]) {
    assert.equal(isFastLanePath(candidate), true, candidate);
  }

  for (const candidate of [
    "Makefile",
    "package.json",
    "scripts/test-identity-integration.sh",
    "apps/desktop/src/main/index.ts",
    "server/cmd/server/main.go",
    "contracts/openapi.yaml",
  ]) {
    assert.equal(isFastLanePath(candidate), false, candidate);
  }
});

test("the gate passes Native Smoke classifications through one Desktop workflow", () => {
  const gateWorkflow = readFileSync(
    join(REPOSITORY, ".github/workflows/ci-gate.yml"),
    "utf8",
  );
  const desktopWorkflow = readFileSync(
    join(REPOSITORY, ".github/workflows/desktop-ci.yml"),
    "utf8",
  );

  assert.match(
    gateWorkflow,
    /windows_native: \$\{\{ steps\.classify\.outputs\.windows_native \}\}/,
  );
  assert.match(
    gateWorkflow,
    /macos_native: \$\{\{ steps\.classify\.outputs\.macos_native \}\}/,
  );
  assert.match(
    gateWorkflow,
    /windows_native: \$\{\{ needs\.changes\.outputs\.windows_native == 'true' \}\}/,
  );
  assert.match(
    gateWorkflow,
    /macos_native: \$\{\{ needs\.changes\.outputs\.macos_native == 'true' \}\}/,
  );
  assert.doesNotMatch(gateWorkflow, /desktop-e2e-ci|skip-e2e|full-e2e|E2E_/);

  assert.match(desktopWorkflow, /workflow_dispatch:/);
  assert.match(desktopWorkflow, /windows_native:[\s\S]*type: boolean/);
  assert.match(desktopWorkflow, /macos_native:[\s\S]*type: boolean/);
  assert.match(
    desktopWorkflow,
    /pnpm --filter @nevix\/desktop test:native:smoke/,
  );
  assert.match(
    desktopWorkflow,
    /pnpm --filter @nevix\/desktop test:native:packaged/,
  );
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
