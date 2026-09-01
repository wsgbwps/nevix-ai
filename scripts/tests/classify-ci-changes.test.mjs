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

test("Desktop documentation and local artifacts stay out of E2E", () => {
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

test("E2E specs and their helpers still require E2E", () => {
  assert.deepEqual(
    selected([
      "apps/desktop/tests/auth/session-persistence.spec.ts",
      "apps/desktop/tests/helpers/electron-app.ts",
    ]),
    { desktop: true, e2e: true },
  );
});

test("ordinary Go packages require only Server CI", () => {
  assert.deepEqual(selected(["server/internal/event/bus.go"]), {
    server: true,
  });
});

test("Identity server changes require Server CI and Desktop E2E", () => {
  assert.deepEqual(
    selected(["server/internal/identity/auth/sessions.go"]),
    { server: true, e2e: true },
  );
});

test("Creation module changes require Server CI and Desktop E2E", () => {
  assert.deepEqual(
    selected(["server/internal/creation/module.go"]),
    { server: true, e2e: true },
  );
  assert.deepEqual(
    selected(["server/internal/creation/integrationtest/harness_test.go"]),
    { server: true, e2e: true },
  );
});

test("the Creation storage contract triggers Server CI and Desktop E2E", () => {
  assert.deepEqual(selected(["contracts/creation.yaml"]), {
    server: true,
    e2e: true,
  });
});

test("API contracts require Server CI and Desktop E2E", () => {
  assert.deepEqual(
    selected(["contracts/identity.yaml"]),
    { server: true, e2e: true },
  );
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

test("the e2e job and gate honor the skip-e2e label with full-e2e precedence", () => {
  const workflow = readFileSync(
    join(REPOSITORY, ".github/workflows/ci-gate.yml"),
    "utf8",
  );

  // full-e2e 的升级请求优先:skip-e2e 只在没有 full-e2e 时生效。
  assert.match(
    workflow,
    /E2E_ENFORCED: \$\{\{ github\.event_name == 'pull_request' && \(contains\(github\.event\.pull_request\.labels\.\*\.name, 'full-e2e'\) \|\| !contains\(github\.event\.pull_request\.labels\.\*\.name, 'skip-e2e'\)\) \}\}/,
  );
  assert.match(workflow, /suite: .*'full' \|\| 'smoke'/);
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
