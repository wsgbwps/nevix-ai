import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  inspectCandidate,
  persistLandingReceipt,
  requireSuccessfulRun,
  verifyPromotion,
} from "../land.mjs";

const REPOSITORY = join(import.meta.dirname, "../..");
const EVIDENCE = join(REPOSITORY, ".codex/hooks/final-state-evidence.mjs");
const PRE_PUSH = join(REPOSITORY, ".husky/pre-push");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (options.expectFailure !== true && result.status !== 0) {
    assert.fail(result.stderr || result.stdout);
  }
  return result;
}

function createRepository(t, accepted = true) {
  const directory = mkdtempSync(join(tmpdir(), "nevix-land-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  run("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: directory,
  });
  run("git", ["config", "user.email", "fixture@example.test"], {
    cwd: directory,
  });
  run("git", ["config", "user.name", "Fixture"], { cwd: directory });
  writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
  run("git", ["add", "package.json"], { cwd: directory });
  run("git", ["commit", "--quiet", "-m", "fixture baseline"], {
    cwd: directory,
  });
  run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
    cwd: directory,
  });
  run("git", ["switch", "--quiet", "-c", "task"], { cwd: directory });

  if (accepted) createAcceptedCandidate(directory);
  return directory;
}

function createAcceptedCandidate(directory) {
  mkdirSync(join(directory, "scripts"), { recursive: true });
  writeFileSync(
    join(directory, "scripts/fixture.mjs"),
    "export const value = 1\n",
  );
  const checked = run(
    process.execPath,
    [
      EVIDENCE,
      "check",
      "--base",
      "origin/main",
      "--name",
      "fixture syntax",
      "--covers",
      "the landing fixture parses",
      "--",
      process.execPath,
      "--check",
      "scripts/fixture.mjs",
    ],
    { cwd: directory },
  );
  const record = JSON.parse(checked.stdout);
  const ledger = {
    schema: "code-review-findings/v1",
    fixedPoint: record.baseCommit,
    scopePaths: record.paths,
    currentDiffDigest: record.finalDiff,
    fullReviewCount: 1,
    targetedReviewRound: 0,
    findings: [],
    repairRecords: [],
    relevantCheck: {
      name: record.relevantCheck,
      result: "PASS",
      coverage: record.checkCoverage,
      diffDigest: record.finalDiff,
    },
    outcome: "closed",
  };
  const ledgerPath = join(directory, ".git/fixture-ledger.json");
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  run(process.execPath, [EVIDENCE, "review", "--ledger", ledgerPath], {
    cwd: directory,
  });
  run("git", ["add", "scripts/fixture.mjs"], { cwd: directory });
  run("git", ["commit", "--quiet", "-m", "fixture candidate"], {
    cwd: directory,
  });
}

function successRun(candidate) {
  return {
    databaseId: 42,
    status: "completed",
    conclusion: "success",
    url: "https://example.test/runs/42",
    headSha: candidate.head,
    headBranch: candidate.readyBranch,
  };
}

test("accepts a clean linear candidate based on origin/main", (t) => {
  const directory = createRepository(t);
  const candidate = inspectCandidate(directory);
  assert.equal(candidate.branch, "task");
  assert.notEqual(candidate.head, candidate.base);
});

test("rejects main, detached, dirty, rebasing, and merge-history states", async (t) => {
  await t.test("main", (t) => {
    const directory = createRepository(t);
    run("git", ["switch", "--quiet", "main"], { cwd: directory });
    assert.throws(() => inspectCandidate(directory), /task branch/);
  });

  await t.test("detached", (t) => {
    const directory = createRepository(t);
    run("git", ["switch", "--quiet", "--detach"], { cwd: directory });
    assert.throws(() => inspectCandidate(directory), /named branch/);
  });

  await t.test("dirty", (t) => {
    const directory = createRepository(t);
    writeFileSync(join(directory, "scripts/fixture.mjs"), "dirty\n");
    assert.throws(() => inspectCandidate(directory), /clean working tree/);
  });

  await t.test("rebase", (t) => {
    const directory = createRepository(t);
    mkdirSync(join(directory, ".git/rebase-merge"));
    assert.throws(() => inspectCandidate(directory), /active Git operation/);
  });

  await t.test("merge commit", (t) => {
    const directory = createRepository(t);
    run("git", ["switch", "--quiet", "-c", "side", "origin/main"], {
      cwd: directory,
    });
    writeFileSync(join(directory, "AGENTS.md"), "fixture\n");
    run("git", ["add", "AGENTS.md"], { cwd: directory });
    run("git", ["commit", "--quiet", "-m", "fixture side"], {
      cwd: directory,
    });
    run("git", ["switch", "--quiet", "task"], { cwd: directory });
    run("git", ["merge", "--quiet", "--no-ff", "side", "-m", "fixture merge"], {
      cwd: directory,
    });
    assert.throws(() => inspectCandidate(directory), /without merge commits/);
  });
});

test("requires an exact successful candidate CI run", (t) => {
  const directory = createRepository(t);
  const candidate = inspectCandidate(directory);
  assert.equal(
    requireSuccessfulRun(
      [successRun(candidate)],
      candidate.head,
      candidate.readyBranch,
    ).databaseId,
    42,
  );

  assert.throws(
    () =>
      requireSuccessfulRun(
        [{ ...successRun(candidate), status: "in_progress", conclusion: "" }],
        candidate.head,
        candidate.readyBranch,
      ),
    /still in_progress/,
  );
  assert.throws(
    () =>
      requireSuccessfulRun(
        [{ ...successRun(candidate), conclusion: "failure" }],
        candidate.head,
        candidate.readyBranch,
      ),
    /concluded failure/,
  );
  assert.throws(
    () =>
      requireSuccessfulRun(
        [{ ...successRun(candidate), headSha: "f".repeat(40) }],
        candidate.head,
        candidate.readyBranch,
      ),
    /no CI gate/,
  );
  assert.throws(
    () =>
      requireSuccessfulRun(
        [
          { ...successRun(candidate), conclusion: "failure", databaseId: 43 },
          successRun(candidate),
        ],
        candidate.head,
        candidate.readyBranch,
      ),
    /concluded failure/,
  );
});

test("verifies evidence, remote base, and exact HEAD before promotion", (t) => {
  const directory = createRepository(t);
  const candidate = inspectCandidate(directory);
  const verified = verifyPromotion(directory, candidate.head, candidate.base, [
    successRun(candidate),
  ]);
  assert.equal(verified.candidate.head, candidate.head);

  assert.throws(
    () =>
      verifyPromotion(directory, "f".repeat(40), candidate.base, [
        successRun(candidate),
      ]),
    /current accepted HEAD/,
  );
  assert.throws(
    () =>
      verifyPromotion(directory, candidate.head, "e".repeat(40), [
        successRun(candidate),
      ]),
    /remote main changed/,
  );
});

test("persists a per-SHA landing receipt and retires the active pointer", (t) => {
  const directory = createRepository(t);
  const candidate = inspectCandidate(directory);
  const verified = verifyPromotion(directory, candidate.head, candidate.base, [
    successRun(candidate),
  ]);
  const receiptPath = persistLandingReceipt(verified);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));

  assert.equal(receipt.contract, "nevix-landing-receipt/v1");
  assert.equal(receipt.landedCommit, candidate.head);
  assert.equal(receipt.ciUrl, successRun(candidate).url);
  assert.equal(receipt.finalDiff, verified.evidence.finalDiff);
  assert.equal(
    existsSync(join(directory, ".git/codex-final-state-evidence/active.json")),
    false,
  );
});

test("rejects a candidate after origin/main advances concurrently", (t) => {
  const directory = createRepository(t);
  run("git", ["switch", "--quiet", "main"], { cwd: directory });
  writeFileSync(
    join(directory, "package.json"),
    '{"type":"module","next":true}\n',
  );
  run("git", ["add", "package.json"], { cwd: directory });
  run("git", ["commit", "--quiet", "-m", "concurrent main"], {
    cwd: directory,
  });
  run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
    cwd: directory,
  });
  run("git", ["switch", "--quiet", "task"], { cwd: directory });

  assert.throws(() => inspectCandidate(directory), /rebased onto/);
});

test("the pre-push hook guards main and ignores candidate branches", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nevix-pre-push-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "node.log");
  const fakeNode = join(directory, "node");
  writeFileSync(
    fakeNode,
    `#!/bin/sh\nprintf '%s\\n' "$*" >>"${log}"\nexit "\${FAKE_NODE_STATUS:-0}"\n`,
  );
  chmodSync(fakeNode, 0o755);
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}` };
  const localSha = "a".repeat(40);
  const remoteSha = "b".repeat(40);

  run("sh", [PRE_PUSH], {
    cwd: REPOSITORY,
    env,
    input: `refs/heads/task ${localSha} refs/heads/ready/${localSha} ${"0".repeat(40)}\n`,
  });
  assert.equal(existsSync(log), false);

  run("sh", [PRE_PUSH], {
    cwd: REPOSITORY,
    env,
    input: `refs/heads/task ${localSha} refs/heads/main ${remoteSha}\n`,
  });
  assert.match(readFileSync(log, "utf8"), /land\.mjs verify-push/);

  const rejected = run("sh", [PRE_PUSH], {
    cwd: REPOSITORY,
    env: { ...env, FAKE_NODE_STATUS: "1" },
    input: `refs/heads/task ${localSha} refs/heads/main ${remoteSha}\n`,
    expectFailure: true,
  });
  assert.notEqual(rejected.status, 0);
});

test("the landing implementation never requests a force push", () => {
  const source = readFileSync(
    join(dirname(import.meta.dirname), "land.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /git[^\n]*push[^\n]*--force/);
});

test("the Codex guard recognizes both Bash command input shapes", () => {
  const hooks = JSON.parse(
    readFileSync(join(REPOSITORY, ".codex/hooks.json"), "utf8"),
  );
  const bashGuard = hooks.hooks.PreToolUse.find(
    (entry) => entry.matcher === "Bash",
  ).hooks[0].command;

  assert.match(bashGuard, /\.tool_input\.command/);
  assert.match(bashGuard, /\.tool_input\.cmd/);
  assert.match(bashGuard, /make land/);
  assert.match(bashGuard, /refs\/heads\/main/);
});
