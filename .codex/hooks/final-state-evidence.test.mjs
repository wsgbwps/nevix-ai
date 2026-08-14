import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const SCRIPT = join(import.meta.dirname, "final-state-evidence.mjs");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (options.expectFailure !== true && result.status !== 0) {
    assert.fail(result.stderr || result.stdout);
  }
  return result;
}

function createRepository() {
  const directory = mkdtempSync(join(tmpdir(), "nevix-final-state-evidence-"));
  run("git", ["init", "--quiet"], { cwd: directory });
  run("git", ["config", "user.email", "fixture@example.test"], {
    cwd: directory,
  });
  run("git", ["config", "user.name", "Fixture"], { cwd: directory });
  writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
  run("git", ["add", "package.json"], { cwd: directory });
  run("git", ["commit", "--quiet", "-m", "fixture baseline"], {
    cwd: directory,
  });
  return directory;
}


function check(directory) {
  const result = run(
    process.execPath,
    [
      SCRIPT,
      "check",
      "--base",
      "HEAD",
      "--name",
      "fixture syntax",
      "--covers",
      "the final JavaScript file parses",
      "--boundary",
      "the fixture candidate parses and binds",
      "--path",
      ".codex/hooks/fixture.mjs",
      "--path",
      "AGENTS.md",
      "--",
      process.execPath,
      "--check",
      ".codex/hooks/fixture.mjs",
    ],
    { cwd: directory },
  );
  return JSON.parse(result.stdout);
}

function writeFindingLedger(directory, record, overrides = {}) {
  const currentDiffDigest = overrides.currentDiffDigest || record.finalDiff;
  const ledger = {
    schema: "code-review-findings/v1",
    fixedPoint: record.baseCommit,
    scopePaths: record.paths,
    currentDiffDigest,
    fullReviewCount: 1,
    targetedReviewRound: 0,
    findings: [],
    repairRecords: [],
    relevantCheck: {
      name: record.relevantCheck,
      result: "PASS",
      coverage: record.checkCoverage,
      diffDigest: currentDiffDigest,
    },
    outcome: "closed",
    ...overrides,
  };
  const path = join(
    directory,
    ".git/codex-final-state-evidence/fixture-findings.json",
  );
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
  return path;
}

function review(directory, ledger, expectFailure = false) {
  const result = run(process.execPath, [SCRIPT, "review", "--ledger", ledger], {
    cwd: directory,
    expectFailure,
  });
  return expectFailure ? result : JSON.parse(result.stdout);
}

function verify(directory, base, expectFailure = false) {
  const result = run(process.execPath, [SCRIPT, "verify", "--base", base], {
    cwd: directory,
    expectFailure,
  });
  return expectFailure ? result : JSON.parse(result.stdout);
}


function createCheckedRepository(t) {
  const directory = createRepository();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixtureDirectory = join(directory, ".codex/hooks");
  const fixture = join(fixtureDirectory, "fixture.mjs");
  mkdirSync(fixtureDirectory, { recursive: true });
  writeFileSync(fixture, "export const value = 1\n");
  writeFileSync(join(directory, "AGENTS.md"), "# Fixture guidance\n");
  return { directory, fixture, record: check(directory) };
}


test("binds a documentation-only candidate", (t) => {
  const directory = createRepository();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "docs"));
  writeFileSync(join(directory, "docs/delivery.md"), "# Delivery\n");

  const result = run(
    process.execPath,
    [
      SCRIPT,
      "check",
      "--base",
      "HEAD",
      "--name",
      "documentation fixture",
      "--covers",
      "the documentation candidate is present",
      "--boundary",
      "the documentation candidate binds",
      "--",
      process.execPath,
      "--eval",
      "process.exit(0)",
    ],
    { cwd: directory },
  );
  const record = JSON.parse(result.stdout);

  assert.equal(record.checkResult, "PASS");
  assert.deepEqual(record.paths, ["docs/delivery.md"]);
});


test("rejects an unresolved blocker unless its risk is explicitly accepted", (t) => {
  const { directory, record } = createCheckedRepository(t);
  const finding = {
    id: "CR-STANDARDS-0001",
    level: "blocker",
    disposition: "accepted",
    dispositionReason: "The defect must be repaired before acceptance.",
    status: "open",
    reviewedDiffDigest: record.finalDiff,
  };
  const ledger = writeFindingLedger(directory, record, {
    findings: [finding],
  });

  const result = review(directory, ledger, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unresolved blocker.*CR-STANDARDS-0001/i);

  const acceptedRiskLedger = writeFindingLedger(directory, record, {
    findings: [
      {
        ...finding,
        riskAcceptance: {
          decision: "accepted",
          acceptedBy: "fixture owner",
          reason: "The owner accepts this bounded fixture risk.",
        },
      },
    ],
  });
  const reviewedRecord = review(directory, acceptedRiskLedger);
  assert.match(reviewedRecord.reviewConclusion, /1 risks explicitly accepted/);
});

test("rejects findings whose closed outcome is only declarative", (t) => {
  const { directory, record } = createCheckedRepository(t);
  const advisoryLedger = writeFindingLedger(directory, record, {
    findings: [
      {
        id: "CR-STANDARDS-0001",
        level: "advisory",
        disposition: "pending",
        status: "open",
        reviewedDiffDigest: record.finalDiff,
      },
    ],
  });
  const advisoryResult = review(directory, advisoryLedger, true);
  assert.notEqual(advisoryResult.status, 0);
  assert.match(
    advisoryResult.stderr,
    /advisory finding.*not explicitly closed/i,
  );

  const blockerLedger = writeFindingLedger(directory, record, {
    findings: [
      {
        id: "CR-SPEC-0001",
        level: "blocker",
        disposition: "pending",
        status: "closed",
        reviewedDiffDigest: record.finalDiff,
      },
    ],
  });
  const blockerResult = review(directory, blockerLedger, true);
  assert.notEqual(blockerResult.status, 0);
  assert.match(blockerResult.stderr, /closed blocker lacks/i);

  const repairedWithoutRecord = writeFindingLedger(directory, record, {
    targetedReviewRound: 1,
    findings: [
      {
        id: "CR-SPEC-0002",
        level: "blocker",
        disposition: "accepted",
        status: "closed",
        reviewedDiffDigest: record.finalDiff,
      },
    ],
  });
  const repairResult = review(directory, repairedWithoutRecord, true);
  assert.notEqual(repairResult.status, 0);
  assert.match(repairResult.stderr, /lacks a current repair record/i);
});

test("rejects a finding ledger bound to a stale diff digest", (t) => {
  const { directory, record } = createCheckedRepository(t);
  const ledger = writeFindingLedger(directory, record, {
    currentDiffDigest: `sha256:${"0".repeat(64)}`,
  });

  const result = review(directory, ledger, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /current diff digest/i);
});


test("keeps accepted evidence valid across committing the same candidate", (t) => {
  const { directory, record } = createCheckedRepository(t);
  const ledger = writeFindingLedger(directory, record);
  const reviewedRecord = review(directory, ledger);

  run("git", ["add", ".codex/hooks/fixture.mjs", "AGENTS.md"], {
    cwd: directory,
  });
  run("git", ["commit", "--quiet", "-m", "fixture candidate"], {
    cwd: directory,
  });

  const verified = verify(directory, record.baseCommit);
  assert.equal(verified.finalDiff, reviewedRecord.finalDiff);
});

test("rejects a changed landing base and incomplete accepted scope", (t) => {
  const directory = createRepository();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, ".codex/hooks"), { recursive: true });
  writeFileSync(
    join(directory, ".codex/hooks/fixture.mjs"),
    "export const value = 1\n",
  );
  writeFileSync(join(directory, "AGENTS.md"), "# Fixture guidance\n");

  const scopedResult = run(
    process.execPath,
    [
      SCRIPT,
      "check",
      "--base",
      "HEAD",
      "--name",
      "fixture syntax",
      "--covers",
      "the scoped JavaScript file parses",
      "--boundary",
      "the scoped fixture candidate parses and binds",
      "--path",
      ".codex/hooks/fixture.mjs",
      "--",
      process.execPath,
      "--check",
      ".codex/hooks/fixture.mjs",
    ],
    { cwd: directory },
  );
  const scopedRecord = JSON.parse(scopedResult.stdout);
  const ledger = writeFindingLedger(directory, scopedRecord);
  review(directory, ledger);

  const incomplete = verify(directory, scopedRecord.baseCommit, true);
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /complete candidate diff/i);

  run("git", ["add", ".codex/hooks/fixture.mjs", "AGENTS.md"], {
    cwd: directory,
  });
  run("git", ["commit", "--quiet", "-m", "fixture candidate"], {
    cwd: directory,
  });
  const changedBase = verify(directory, "HEAD", true);
  assert.notEqual(changedBase.status, 0);
  assert.match(changedBase.stderr, /base no longer matches/i);
});


test("closes a low-risk candidate on check alone without a review ledger", (t) => {
  const directory = createRepository();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "AGENTS.md"), "# Fixture guidance\n");
  mkdirSync(join(directory, "docs"));
  writeFileSync(join(directory, "docs/guide.md"), "# Guide\n");

  const result = run(
    process.execPath,
    [
      SCRIPT,
      "check",
      "--base",
      "HEAD",
      "--name",
      "documentation fixture",
      "--covers",
      "the documentation candidate is present",
      "--boundary",
      "the documentation candidate closes on check alone",
      "--risk",
      "low",
      "--",
      process.execPath,
      "--eval",
      "process.exit(0)",
    ],
    { cwd: directory },
  );
  const lowRisk = JSON.parse(result.stdout);
  assert.equal(lowRisk.risk, "low");
  assert.equal(lowRisk.checkResult, "PASS");
  assert.equal(lowRisk.acceptanceBoundary, "the documentation candidate closes on check alone");
  assert.equal(lowRisk.findingLedger, undefined);

  const verified = verify(directory, lowRisk.baseCommit);
  assert.equal(verified.finalDiff, lowRisk.finalDiff);
  assert.equal(verified.risk, "low");
  assert.equal(verified.acceptanceBoundary, lowRisk.acceptanceBoundary);
});

test("requires an acceptance boundary", (t) => {
  const { directory } = createCheckedRepository(t);
  const result = run(
    process.execPath,
    [
      SCRIPT,
      "check",
      "--base",
      "HEAD",
      "--name",
      "fixture syntax",
      "--covers",
      "the fixture is present",
      "--",
      process.execPath,
      "--check",
      ".codex/hooks/fixture.mjs",
    ],
    { cwd: directory, expectFailure: true },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--boundary/);
});

test("rejects low-risk candidates with non-documentation paths", (t) => {
  const { directory } = createCheckedRepository(t);
  const result = run(
    process.execPath,
    [
      SCRIPT,
      "check",
      "--base",
      "HEAD",
      "--name",
      "fixture syntax",
      "--covers",
      "the final JavaScript file parses",
      "--boundary",
      "the fixture candidate binds",
      "--risk",
      "low",
      "--path",
      ".codex/hooks/fixture.mjs",
      "--path",
      "AGENTS.md",
      "--",
      process.execPath,
      "--check",
      ".codex/hooks/fixture.mjs",
    ],
    { cwd: directory, expectFailure: true },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ineligible paths/);
});

test("gates low risk on dependency-only package.json changes", (t) => {
  const checkArgs = (directory) => [
    SCRIPT,
    "check",
    "--base",
    "HEAD",
    "--name",
    "package fixture",
    "--covers",
    "the package manifest change is dependency-only",
    "--boundary",
    "the dependency-only change binds",
    "--risk",
    "low",
    "--path",
    "package.json",
    "--",
    process.execPath,
    "--eval",
    "process.exit(0)",
  ];

  const dependencyDirectory = createRepository();
  t.after(() =>
    rmSync(dependencyDirectory, { recursive: true, force: true }),
  );
  writeFileSync(
    join(dependencyDirectory, "package.json"),
    '{"type":"module","packageManager":"pnpm@11.21.0"}\n',
  );
  const dependencyResult = run(process.execPath, checkArgs(dependencyDirectory), {
    cwd: dependencyDirectory,
  });
  const dependencyRecord = JSON.parse(dependencyResult.stdout);
  assert.equal(dependencyRecord.risk, "low");
  assert.equal(dependencyRecord.checkResult, "PASS");
  verify(dependencyDirectory, dependencyRecord.baseCommit);

  const scriptDirectory = createRepository();
  t.after(() => rmSync(scriptDirectory, { recursive: true, force: true }));
  writeFileSync(
    join(scriptDirectory, "package.json"),
    '{"type":"module","scripts":{"postinstall":"true"}}\n',
  );
  const scriptResult = run(process.execPath, checkArgs(scriptDirectory), {
    cwd: scriptDirectory,
    expectFailure: true,
  });
  assert.notEqual(scriptResult.status, 0);
  assert.match(scriptResult.stderr, /ineligible paths/);
});

test("keeps the finding ledger required after a review upgrade", (t) => {
  const directory = createRepository();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "AGENTS.md"), "# Fixture guidance\n");
  mkdirSync(join(directory, "docs"));
  writeFileSync(join(directory, "docs/guide.md"), "# Guide\n");
  const checkArgs = [
    SCRIPT,
    "check",
    "--base",
    "HEAD",
    "--name",
    "documentation fixture",
    "--covers",
    "the documentation candidate is present",
    "--boundary",
    "the documentation candidate binds",
    "--risk",
    "low",
    "--",
    process.execPath,
    "--eval",
    "process.exit(0)",
  ];

  const lowRisk = JSON.parse(
    run(process.execPath, checkArgs, { cwd: directory }).stdout,
  );
  assert.equal(lowRisk.risk, "low");
  verify(directory, lowRisk.baseCommit);

  const ledger = writeFindingLedger(directory, lowRisk);
  review(directory, ledger);

  const rechecked = JSON.parse(
    run(process.execPath, checkArgs, { cwd: directory }).stdout,
  );
  assert.equal(rechecked.risk, "low");
  assert.equal(rechecked.findingLedger, undefined);

  const downgraded = verify(directory, lowRisk.baseCommit, true);
  assert.notEqual(downgraded.status, 0);
  assert.match(downgraded.stderr, /previously reviewed/);

  review(directory, ledger);
  const upgraded = verify(directory, lowRisk.baseCommit);
  assert.equal(upgraded.finalDiff, lowRisk.finalDiff);
});



test("refuses trivial no-op check commands", (t) => {
  const directory = createRepository();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, ".codex/hooks"), { recursive: true });
  writeFileSync(
    join(directory, ".codex/hooks/fixture.mjs"),
    "export const value = 1\n",
  );

  const result = run(
    process.execPath,
    [
      SCRIPT,
      "check",
      "--base",
      "HEAD",
      "--name",
      "fixture syntax",
      "--covers",
      "the fixture is present",
      "--boundary",
      "the fixture candidate binds",
      "--",
      "true",
    ],
    { cwd: directory, expectFailure: true },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /trivial no-op/);
});

test("captures the check output tail into the record", (t) => {
  const { directory, record } = createCheckedRepository(t);
  assert.equal(typeof record.checkOutputTail, "string");

  const result = run(
    process.execPath,
    [
      SCRIPT,
      "check",
      "--base",
      "HEAD",
      "--name",
      "fixture syntax",
      "--covers",
      "the fixture check prints",
      "--boundary",
      "the fixture candidate binds",
      "--path",
      ".codex/hooks/fixture.mjs",
      "--path",
      "AGENTS.md",
      "--",
      process.execPath,
      "--eval",
      "process.stderr.write('fixture-tail-ok')",
    ],
    { cwd: directory },
  );
  const printed = JSON.parse(result.stdout);
  assert.match(printed.checkOutputTail, /fixture-tail-ok/);
});
