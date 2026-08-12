import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixture = JSON.parse(
  await readFile(
    new URL("./review-lifecycle.fixture.json", import.meta.url),
    "utf8",
  ),
);

const initialById = new Map(
  fixture.initial.findings.map((finding) => [finding.id, finding]),
);
const blockerId = "CR-STANDARDS-0001";
const closedInitialIds = fixture.initial.findings
  .filter((finding) => finding.status === "closed")
  .map((finding) => finding.id);

function applyTargetedResult(initialFindings, result) {
  const finalById = new Map(
    initialFindings.map((finding) => [finding.id, structuredClone(finding)]),
  );

  for (const update of result.updates) {
    assert.ok(finalById.has(update.id), `unknown update ID: ${update.id}`);
    finalById.set(update.id, { ...finalById.get(update.id), ...update });
  }
  for (const finding of result.newFindings) {
    assert.ok(!finalById.has(finding.id), `recreated finding ID: ${finding.id}`);
    finalById.set(finding.id, finding);
  }

  return finalById;
}

test("fixture contains blocker, advisory, and false-positive dispositions", () => {
  assert.equal(initialById.get(blockerId).level, "blocker");
  assert.ok(
    fixture.initial.findings.some((finding) => finding.level === "advisory"),
  );
  assert.ok(
    fixture.initial.findings.some(
      (finding) => finding.disposition === "false-positive",
    ),
  );
});

test("targeted re-review preserves the old ID and never retargets closed IDs", () => {
  const result = fixture.success.targetedResult;
  const finalById = applyTargetedResult(fixture.initial.findings, result);

  assert.equal(result.fullReviewStarted, false);
  assert.equal(result.fullReviewCount, 1);
  assert.deepEqual(result.targetedIds, [blockerId]);
  assert.equal(result.updates[0].id, blockerId);
  assert.equal(result.updates[0].status, "closed");
  assert.deepEqual(
    finalById.get(blockerId).identity,
    initialById.get(blockerId).identity,
  );
  for (const id of closedInitialIds) {
    assert.ok(!result.targetedIds.includes(id));
    assert.ok(!result.updates.some((update) => update.id === id));
    assert.ok(!result.newFindings.some((finding) => finding.id === id));
    assert.deepEqual(finalById.get(id), initialById.get(id));
  }
  assert.equal(
    finalById.size,
    fixture.initial.findings.length + result.newFindings.length,
  );
});

test("a repair-introduced finding records its source", () => {
  const [finding] = fixture.success.targetedResult.newFindings;
  const provenance = finding.introducedBy;

  assert.equal(provenance.kind, "repair");
  assert.deepEqual(provenance.findingIds, [blockerId]);
  assert.equal(
    provenance.repairDiffDigest,
    fixture.success.repairRecord.repairDiffDigest,
  );
});

test("normal closure is bound to a passing check on the current digest", () => {
  const result = fixture.success.targetedResult;
  const finalFindings = [
    ...applyTargetedResult(fixture.initial.findings, result).values(),
  ];

  assert.equal(result.outcome, "closed");
  assert.equal(result.relevantCheck.result, "PASS");
  assert.equal(result.relevantCheck.diffDigest, result.currentDiffDigest);
  assert.ok(
    finalFindings
      .filter((finding) => finding.level === "blocker")
      .every((finding) => finding.status === "closed"),
  );
  assert.ok(
    finalFindings
      .filter((finding) => finding.level === "advisory")
      .every((finding) => finding.disposition !== "pending"),
  );
});

test("two unresolved targeted rounds escalate without another full review", () => {
  const [first, second] = fixture.escalation.rounds;

  assert.equal(first.updates[0].id, blockerId);
  assert.equal(second.updates[0].id, blockerId);
  assert.equal(second.updates[0].unresolvedTargetedRounds, 2);
  assert.equal(second.updates[0].status, "escalated");
  assert.equal(second.outcome, "escalated");
  assert.equal(fixture.escalation.fullReviewCount, 1);
  assert.ok(fixture.escalation.rounds.every((round) => !round.fullReviewStarted));
});
