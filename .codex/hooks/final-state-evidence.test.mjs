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

function stop(directory, message = "", stopHookActive = false) {
  const input = JSON.stringify({
    hook_event_name: "Stop",
    last_assistant_message: message,
    stop_hook_active: stopHookActive,
  });
  const result = run(process.execPath, [SCRIPT], { cwd: directory, input });
  return JSON.parse(result.stdout);
}

function check(directory) {
  const result = run(
    process.execPath,
    [
      SCRIPT,
      "check",
      "--name",
      "fixture syntax",
      "--covers",
      "the final JavaScript file parses",
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
    fixedPoint: "fixture-base",
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
  const result = run(
    process.execPath,
    [SCRIPT, "review", "--ledger", ledger],
    { cwd: directory, expectFailure },
  );
  return expectFailure ? result : JSON.parse(result.stdout);
}

function acceptedEvidence(record) {
  return [
    "Final-state evidence",
    "- Acceptance boundary: the fixture must parse",
    `- Final diff: ${record.finalDiff}`,
    `- Relevant check: ${record.relevantCheck}`,
    "- Check result: PASS",
    `- Check coverage: ${record.checkCoverage}`,
    `- Finding ledger: ${record.findingLedger}`,
    `- Finding ledger digest: ${record.findingLedgerDigest}`,
    `- Review conclusion: ${record.reviewConclusion}`,
    "- Closure: accepted",
  ].join("\n");
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

test("allows stop when there is no code diff", (t) => {
  const directory = createRepository();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.deepEqual(stop(directory), {});
});

test("requires a post-change relevant check and reviewed handoff", (t) => {
  const directory = createRepository();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = join(directory, ".codex/hooks/fixture.mjs");
  mkdirSync(join(directory, ".codex/hooks"), { recursive: true });
  writeFileSync(fixture, "export const value = 1\n");
  writeFileSync(join(directory, "AGENTS.md"), "# Fixture guidance\n");
  mkdirSync(join(directory, ".codex/better-harness/run"), { recursive: true });
  writeFileSync(
    join(directory, ".codex/better-harness/run/report.json"),
    "{}\n",
  );
  mkdirSync(join(directory, "scripts"), { recursive: true });
  writeFileSync(join(directory, "scripts/unrelated.sh"), "#!/bin/sh\n");

  const missingCheck = stop(directory);
  assert.equal(missingCheck.decision, "block");
  assert.match(
    missingCheck.reason,
    /Run the relevant check after the final code edit/,
  );

  const record = check(directory);
  assert.equal(record.checkResult, "PASS");
  assert.deepEqual(record.paths, [".codex/hooks/fixture.mjs", "AGENTS.md"]);
  assert.equal(record.paths.includes("scripts/unrelated.sh"), false);

  const missingReview = stop(
    directory,
    [
      "Final-state evidence",
      "- Acceptance boundary: the fixture must parse",
      `- Final diff: ${record.finalDiff}`,
      "- Relevant check: fixture syntax",
      "- Check result: PASS",
      "- Check coverage: the final JavaScript file parses",
      "- Closure: accepted",
    ].join("\n"),
  );
  assert.equal(missingReview.decision, "block");
  assert.match(missingReview.reason, /record the conclusion/);

  const unreviewedConclusion = stop(
    directory,
    [
      "Final-state evidence",
      "- Acceptance boundary: the fixture must parse",
      `- Final diff: ${record.finalDiff}`,
      "- Relevant check: fixture syntax",
      "- Check result: PASS",
      "- Check coverage: the final JavaScript file parses",
      "- Review conclusion: The final diff and relevant check have no findings.",
      "- Closure: accepted",
    ].join("\n"),
  );
  assert.equal(unreviewedConclusion.decision, "block");

  const textOnlyReview = run(
    process.execPath,
    [
      SCRIPT,
      "review",
      "--conclusion",
      "Reviewed the final diff and relevant check; no findings.",
    ],
    { cwd: directory, expectFailure: true },
  );
  assert.notEqual(textOnlyReview.status, 0);
  assert.match(textOnlyReview.stderr, /--ledger/);

  const ledger = writeFindingLedger(directory, record);
  const reviewedRecord = review(directory, ledger);
  assert.match(reviewedRecord.reviewConclusion, /0 blockers/);
  assert.equal(reviewedRecord.findingLedger, ledger);
  assert.match(reviewedRecord.findingLedgerDigest, /^sha256:[a-f0-9]{64}$/);

  const mismatchedFinalDiff = stop(
    directory,
    [
      "Final-state evidence",
      "- Acceptance boundary: the fixture must parse",
      `- Final diff: sha256:${"0".repeat(64)}`,
      "- Relevant check: fixture syntax",
      "- Check result: PASS",
      "- Check coverage: the final JavaScript file parses",
      `- Finding ledger: ${reviewedRecord.findingLedger}`,
      `- Finding ledger digest: ${reviewedRecord.findingLedgerDigest}`,
      `- Review conclusion: ${reviewedRecord.reviewConclusion}`,
      "- Closure: accepted",
    ].join("\n"),
  );
  assert.equal(mismatchedFinalDiff.decision, "block");

  const accepted = stop(directory, acceptedEvidence(reviewedRecord));
  assert.deepEqual(accepted, {});

  writeFileSync(fixture, "export const value = 2\n");
  const stale = stop(directory);
  assert.equal(stale.decision, "block");
  assert.match(stale.reason, /failed, stale, or malformed/);

  writeFileSync(
    join(directory, ".git/codex-final-state-evidence/active.json"),
    "{\n",
  );
  const malformedState = stop(directory);
  assert.equal(malformedState.decision, "block");
  assert.match(
    malformedState.reason,
    /Run the relevant check after the final code edit/,
  );
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

test("rejects a finding ledger bound to a stale diff digest", (t) => {
  const { directory, record } = createCheckedRepository(t);
  const ledger = writeFindingLedger(directory, record, {
    currentDiffDigest: `sha256:${"0".repeat(64)}`,
  });

  const result = review(directory, ledger, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /current diff digest/i);
});

test("rejects a later edit that was checked but not re-reviewed", (t) => {
  const { directory, fixture, record } = createCheckedRepository(t);
  const ledger = writeFindingLedger(directory, record);
  const reviewedRecord = review(directory, ledger);
  assert.deepEqual(stop(directory, acceptedEvidence(reviewedRecord)), {});

  writeFileSync(fixture, "export const value = 2\n");
  const currentRecord = check(directory);
  const result = stop(directory, acceptedEvidence(currentRecord));

  assert.equal(result.decision, "block");
  assert.match(result.reason, /targeted re-review after the final code edit/i);
});

test("avoids an infinite continuation loop", (t) => {
  const directory = createRepository();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixtureDirectory = join(directory, ".codex/hooks");
  mkdirSync(fixtureDirectory, { recursive: true });
  writeFileSync(
    join(fixtureDirectory, "fixture.mjs"),
    "export const value = 1\n",
  );

  const result = stop(directory, "", true);
  assert.equal(result.decision, undefined);
  assert.match(result.systemMessage, /remains incomplete/);
});
