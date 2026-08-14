import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = join(import.meta.dirname, "../..");
const harness = join(repoRoot, "scripts/auth-policy-harness.mjs");
const policyFiles = {
  config: join(repoRoot, "supabase/config.toml"),
  environment: join(repoRoot, "supabase/auth-policy.env.example"),
  desktop: join(
    repoRoot,
    "apps/desktop/src/renderer/src/features/authentication/policy/password.ts",
  ),
};

function fixtureFiles(t) {
  const directory = mkdtempSync(join(tmpdir(), "nevix-auth-policy-parity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  return Object.fromEntries(
    Object.entries(policyFiles).map(([name, source]) => {
      const destination = join(directory, basename(source));
      writeFileSync(destination, readFileSync(source));
      return [name, destination];
    }),
  );
}

function runParity(files) {
  return spawnSync(process.execPath, [harness, "parity"], {
    encoding: "utf8",
    env: {
      ...process.env,
      NEVIX_AUTH_POLICY_CONFIG_TOML: files.config,
      NEVIX_AUTH_POLICY_ENV_FILE: files.environment,
      NEVIX_AUTH_POLICY_DESKTOP_PASSWORD_POLICY: files.desktop,
    },
  });
}

function replaceOnce(path, search, replacement) {
  const source = readFileSync(path, "utf8");
  assert.equal(
    source.split(search).length,
    2,
    `${search} must occur exactly once`,
  );
  writeFileSync(path, source.replace(search, replacement));
}

test("committed Auth policy projections remain in parity", (t) => {
  const result = runParity(fixtureFiles(t));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    /committed Auth policy projections remain in parity/,
  );
});

test("Auth policy parity rejects drift with the responsible mapping", async (t) => {
  const examples = [
    {
      name: "Supabase Session inactivity",
      file: "config",
      search: 'inactivity_timeout = "336h"',
      replacement: 'inactivity_timeout = "335h"',
      expected: /Session inactivity.*GOTRUE_SESSIONS_INACTIVITY_TIMEOUT/,
    },
    {
      name: "GoTrue password minimum",
      file: "environment",
      search: "GOTRUE_PASSWORD_MIN_LENGTH=12",
      replacement: "GOTRUE_PASSWORD_MIN_LENGTH=13",
      expected: /password minimum.*GOTRUE_PASSWORD_MIN_LENGTH/,
    },
    {
      name: "Desktop password maximum",
      file: "desktop",
      search: "MAXIMUM_PASSWORD_BYTES = 72",
      replacement: "MAXIMUM_PASSWORD_BYTES = 71",
      expected: /password maximum.*MAXIMUM_PASSWORD_BYTES/,
    },
  ];

  for (const example of examples) {
    await t.test(example.name, (t) => {
      const files = fixtureFiles(t);
      replaceOnce(files[example.file], example.search, example.replacement);
      const result = runParity(files);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, example.expected);
    });
  }
});
