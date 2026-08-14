#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function git(cwd, args, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd, encoding });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(detail || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function zeroDelimited(value) {
  return value.toString("utf8").split("\0").filter(Boolean);
}

function isTaskPath(path) {
  return !path.startsWith(".codex/better-harness/");
}

function repository(cwd = process.cwd()) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const rawGitDir = git(root, ["rev-parse", "--git-dir"]).trim();
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(root, rawGitDir);
  return { root, gitDir };
}

function resolveCommit(root, ref) {
  return git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}

function defaultBase(root) {
  let branch = "";
  try {
    branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
  } catch {
    return resolveCommit(root, "HEAD");
  }
  if (branch !== "main") {
    try {
      return git(root, ["merge-base", "HEAD", "origin/main"]).trim();
    } catch {
      // A local-only fixture or repository still binds its working diff to HEAD.
    }
  }
  return resolveCommit(root, "HEAD");
}

function hashPathState(hash, root, path) {
  const absolutePath = join(root, path);
  if (!existsSync(absolutePath)) {
    hash.update("deleted\0");
    return;
  }

  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    hash.update("symlink\0");
    hash.update(readlinkSync(absolutePath));
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`unsupported changed path type: ${path}`);
  }

  hash.update(stat.mode & 0o111 ? "executable\0" : "file\0");
  hash.update(readFileSync(absolutePath));
}

export function snapshot(
  cwd = process.cwd(),
  pathScope = null,
  baseRef = "HEAD",
) {
  const repo = repository(cwd);
  const baseCommit = resolveCommit(repo.root, baseRef);
  const tracked = new Set(
    zeroDelimited(
      git(repo.root, ["diff", "--name-only", "-z", baseCommit, "--"], null),
    ),
  );
  const untracked = new Set(
    zeroDelimited(
      git(
        repo.root,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        null,
      ),
    ),
  );
  const changedPaths = [...new Set([...tracked, ...untracked])]
    .filter(isTaskPath)
    .sort();
  const paths = pathScope ? [...new Set(pathScope)].sort() : changedPaths;

  if (
    paths.some(
      (path) =>
        !changedPaths.includes(path) ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").includes("..") ||
        !isTaskPath(path),
    ) ||
    paths.length === 0
  ) {
    return { ...repo, baseCommit, digest: null, paths: [] };
  }

  const hash = createHash("sha256");
  hash.update("nevix-final-state-evidence/v2\0");
  hash.update(baseCommit);
  hash.update("\0");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hashPathState(hash, repo.root, path);
    hash.update("\0");
  }

  return { ...repo, baseCommit, digest: hash.digest("hex"), paths };
}

function recordPath(state, finalDiff) {
  if (!DIGEST_PATTERN.test(finalDiff)) {
    throw new Error("invalid final diff identity");
  }
  return join(
    state.gitDir,
    "codex-final-state-evidence",
    `${finalDiff.slice("sha256:".length)}.json`,
  );
}

function contentDigest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function statePath(state) {
  return recordPath(state, `sha256:${state.digest}`);
}

function activePath(state) {
  return join(state.gitDir, "codex-final-state-evidence", "active.json");
}

function writeRecord(state, record) {
  const path = statePath(state);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(
    activePath(state),
    `${JSON.stringify(
      {
        finalDiff: record.finalDiff,
        baseCommit: record.baseCommit,
        paths: record.paths,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

function readActive(cwd = process.cwd()) {
  const repo = repository(cwd);
  if (!existsSync(activePath(repo))) return null;

  try {
    const pointer = JSON.parse(readFileSync(activePath(repo), "utf8"));
    if (!Array.isArray(pointer.paths) || !pointer.baseCommit) return null;
    const path = recordPath(repo, pointer.finalDiff);
    if (!existsSync(path)) return null;

    const record = JSON.parse(readFileSync(path, "utf8"));
    return {
      current: snapshot(repo.root, pointer.paths, pointer.baseCommit),
      record,
    };
  } catch {
    return null;
  }
}

function parseCheckArguments(args) {
  let base = "";
  let name = "";
  let covers = "";
  const paths = [];
  let index = 0;

  while (index < args.length && args[index] !== "--") {
    const flag = args[index];
    const value = args[index + 1];
    if (
      (flag === "--base" ||
        flag === "--name" ||
        flag === "--covers" ||
        flag === "--path") &&
      value
    ) {
      if (flag === "--base") base = value.trim();
      if (flag === "--name") name = value.trim();
      if (flag === "--covers") covers = value.trim();
      if (flag === "--path") paths.push(value.trim());
      index += 2;
      continue;
    }
    throw new Error(`unknown or incomplete option: ${flag}`);
  }

  if (!base || !name || !covers || args[index] !== "--" || !args[index + 1]) {
    throw new Error(
      "usage: final-state-evidence.mjs check --base <fixed-point> --name <identity> --covers <behavior-or-risk> [--path <task-path> ...] -- <command> [args...]",
    );
  }
  if (name.length > 160 || covers.length > 400) {
    throw new Error("check identity or coverage is too long");
  }

  return {
    base,
    name,
    covers,
    paths,
    command: args[index + 1],
    commandArgs: args.slice(index + 2),
  };
}

function runCheck(args) {
  const parsed = parseCheckArguments(args);
  const before = snapshot(
    process.cwd(),
    parsed.paths.length > 0 ? parsed.paths : null,
    parsed.base,
  );
  if (!before.digest) {
    throw new Error("no candidate diff to bind");
  }

  const result = spawnSync(parsed.command, parsed.commandArgs, {
    cwd: before.root,
    stdio: "inherit",
  });
  const after = snapshot(before.root, before.paths, before.baseCommit);
  const exitCode = Number.isInteger(result.status) ? result.status : 1;
  const unchanged = before.digest === after.digest;
  const status =
    exitCode === 0 && unchanged ? "PASS" : unchanged ? "FAIL" : "STALE";
  const record = {
    contract: "nevix-final-state-evidence/v2",
    baseCommit: after.baseCommit,
    finalDiff: `sha256:${after.digest}`,
    paths: after.paths,
    relevantCheck: parsed.name,
    checkResult: status,
    checkCoverage: parsed.covers,
    commandHash: createHash("sha256")
      .update(JSON.stringify([parsed.command, ...parsed.commandArgs]))
      .digest("hex"),
    checkedAt: new Date().toISOString(),
  };

  writeRecord(after, record);

  if (!unchanged) {
    process.stderr.write(
      "candidate diff changed while the check ran; rerun after the final edit\n",
    );
    return 3;
  }
  return exitCode;
}

function readFindingLedger(path, root, record) {
  const findingLedger = resolve(root, path);
  let content;
  let ledger;
  try {
    content = readFileSync(findingLedger);
    ledger = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error("finding ledger must be a readable JSON file");
  }

  if (
    ledger?.schema !== "code-review-findings/v1" ||
    typeof ledger.fixedPoint !== "string" ||
    !Array.isArray(ledger.scopePaths) ||
    ledger.fullReviewCount !== 1 ||
    !Number.isInteger(ledger.targetedReviewRound) ||
    ledger.targetedReviewRound < 0 ||
    ledger.targetedReviewRound > 2 ||
    !Array.isArray(ledger.findings) ||
    !Array.isArray(ledger.repairRecords) ||
    ledger.outcome !== "closed"
  ) {
    throw new Error("finding ledger is malformed or not closed");
  }
  if (ledger.currentDiffDigest !== record.finalDiff) {
    throw new Error("finding ledger does not match the current diff digest");
  }
  let ledgerFixedPoint;
  try {
    ledgerFixedPoint = resolveCommit(root, ledger.fixedPoint);
  } catch {
    throw new Error("finding ledger fixed point is not a commit");
  }
  if (
    ledgerFixedPoint !== record.baseCommit ||
    JSON.stringify([...ledger.scopePaths].sort()) !==
      JSON.stringify([...record.paths].sort())
  ) {
    throw new Error(
      "finding ledger boundary does not match the accepted candidate",
    );
  }
  if (
    ledger.relevantCheck?.name !== record.relevantCheck ||
    ledger.relevantCheck?.result !== "PASS" ||
    ledger.relevantCheck?.coverage !== record.checkCoverage ||
    ledger.relevantCheck?.diffDigest !== record.finalDiff
  ) {
    throw new Error(
      "finding ledger relevant check is not PASS on the current diff digest",
    );
  }

  const ids = new Set();
  const blockers = [];
  const unresolved = [];
  let acceptedRiskCount = 0;
  let repairedBlockerCount = 0;

  for (const finding of ledger.findings) {
    if (
      !finding ||
      typeof finding !== "object" ||
      typeof finding.id !== "string" ||
      !finding.id ||
      ids.has(finding.id) ||
      !["blocker", "advisory"].includes(finding.level) ||
      finding.reviewedDiffDigest !== record.finalDiff
    ) {
      throw new Error(
        "finding ledger entries must have unique IDs and review the current diff digest",
      );
    }
    ids.add(finding.id);
    const risk = finding.riskAcceptance;
    const acceptedRisk =
      risk?.decision === "accepted" &&
      typeof risk.acceptedBy === "string" &&
      Boolean(risk.acceptedBy.trim()) &&
      typeof risk.reason === "string" &&
      Boolean(risk.reason.trim());
    const supportedFalsePositive =
      finding.disposition === "false-positive" &&
      typeof finding.dispositionReason === "string" &&
      Boolean(finding.dispositionReason.trim());

    if (finding.level === "advisory") {
      if (
        finding.status !== "closed" ||
        !["deferred", "false-positive"].includes(finding.disposition) ||
        (finding.disposition === "false-positive" && !supportedFalsePositive)
      ) {
        throw new Error(
          `advisory finding is not explicitly closed: ${finding.id}`,
        );
      }
      continue;
    }

    blockers.push(finding);
    if (finding.status === "closed") {
      if (finding.disposition === "accepted") {
        const repair = ledger.repairRecords.find(
          (repairRecord) =>
            Array.isArray(repairRecord?.fixFor) &&
            repairRecord.fixFor.includes(finding.id) &&
            repairRecord.afterDiffDigest === record.finalDiff,
        );
        if (!repair) {
          throw new Error(
            `closed repaired blocker lacks a current repair record: ${finding.id}`,
          );
        }
        repairedBlockerCount += 1;
      } else if (!supportedFalsePositive) {
        throw new Error(
          `closed blocker lacks an accepted repair or supported false-positive disposition: ${finding.id}`,
        );
      }
      continue;
    }
    if (acceptedRisk) {
      acceptedRiskCount += 1;
      continue;
    }
    unresolved.push(finding.id);
  }

  if (unresolved.length > 0) {
    throw new Error(`unresolved blocker findings: ${unresolved.join(", ")}`);
  }
  if (repairedBlockerCount > 0 && ledger.targetedReviewRound < 1) {
    throw new Error(
      "repaired blockers require a completed targeted re-review on the current diff digest",
    );
  }

  return {
    content,
    findingLedger,
    findingLedgerDigest: contentDigest(content),
    reviewConclusion: [
      `Finding ledger closed on ${record.finalDiff}:`,
      `${blockers.length - acceptedRiskCount} blockers closed,`,
      `${acceptedRiskCount} risks explicitly accepted;`,
      `targeted re-review round ${ledger.targetedReviewRound}.`,
    ].join(" "),
  };
}

function persistFindingLedger(state, evidence) {
  const digest = evidence.findingLedgerDigest.slice("sha256:".length);
  const path = join(
    state.gitDir,
    "codex-final-state-evidence",
    "ledgers",
    `${digest}.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, evidence.content, { mode: 0o600 });
  return { ...evidence, content: undefined, findingLedger: path };
}

function runReview(args) {
  if (args.length !== 2 || args[0] !== "--ledger" || !args[1].trim()) {
    throw new Error(
      "usage: final-state-evidence.mjs review --ledger <code-review-findings.json>",
    );
  }

  const active = readActive();
  if (!active) {
    throw new Error(
      "run the relevant check after the final code edit before review",
    );
  }

  const { current, record } = active;
  if (
    !current.digest ||
    record.contract !== "nevix-final-state-evidence/v2" ||
    record.baseCommit !== current.baseCommit ||
    record.finalDiff !== `sha256:${current.digest}` ||
    record.checkResult !== "PASS"
  ) {
    throw new Error("the relevant-check record is failed, stale, or malformed");
  }

  const evidence = persistFindingLedger(
    current,
    readFindingLedger(args[1], current.root, record),
  );
  const reviewedRecord = {
    ...record,
    ...evidence,
    reviewedDiff: record.finalDiff,
    reviewedAt: new Date().toISOString(),
  };
  writeRecord(current, reviewedRecord);
  return 0;
}

function validateReviewedRecord(current, record) {
  if (
    !current.digest ||
    record.contract !== "nevix-final-state-evidence/v2" ||
    record.baseCommit !== current.baseCommit ||
    record.finalDiff !== `sha256:${current.digest}` ||
    record.checkResult !== "PASS" ||
    record.reviewedDiff !== record.finalDiff
  ) {
    throw new Error("the accepted evidence is failed, stale, or malformed");
  }

  const reviewEvidence = readFindingLedger(
    record.findingLedger || "",
    current.root,
    record,
  );
  if (
    record.findingLedger !== reviewEvidence.findingLedger ||
    record.findingLedgerDigest !== reviewEvidence.findingLedgerDigest ||
    record.reviewConclusion !== reviewEvidence.reviewConclusion
  ) {
    throw new Error("the accepted review ledger is stale or malformed");
  }
}

export function verifyAcceptedCandidate(cwd = process.cwd(), baseRef) {
  if (!baseRef) throw new Error("a landing base is required");
  const active = readActive(cwd);
  if (!active) throw new Error("no final-state evidence is active");

  const requestedBase = resolveCommit(active.current.root, baseRef);
  if (requestedBase !== active.record.baseCommit) {
    throw new Error("the accepted base no longer matches the landing base");
  }

  const full = snapshot(active.current.root, null, requestedBase);
  if (
    JSON.stringify(full.paths) !== JSON.stringify(active.record.paths) ||
    full.digest !== active.current.digest
  ) {
    throw new Error(
      "final-state evidence does not cover the complete candidate diff",
    );
  }
  validateReviewedRecord(full, active.record);
  return { ...active.record, root: full.root, gitDir: full.gitDir };
}

function runVerify(args) {
  if (args.length !== 2 || args[0] !== "--base" || !args[1].trim()) {
    throw new Error(
      "usage: final-state-evidence.mjs verify --base <fixed-point>",
    );
  }
  const record = verifyAcceptedCandidate(process.cwd(), args[1]);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  return 0;
}

function field(message, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.match(
    new RegExp(`^\\s*- ${escaped}:\\s*(.+?)\\s*$`, "mi"),
  )?.[1];
}

function block(input, reason) {
  if (input.stop_hook_active) {
    return {
      systemMessage: `Final-state evidence remains incomplete: ${reason}`,
    };
  }
  return { decision: "block", reason };
}

export function evaluateStop(input, cwd = process.cwd()) {
  const repo = repository(cwd);
  const active = readActive(cwd);
  const changed = active
    ? snapshot(repo.root, null, active.record.baseCommit)
    : snapshot(repo.root, null, defaultBase(repo.root));
  if (!changed.digest) return {};

  if (!active) {
    return block(
      input,
      'Run the relevant check after the final code edit with `node .codex/hooks/final-state-evidence.mjs check --base origin/main --name "<identity>" --covers "<behavior or risk>" -- <command> [args...]`, then review the final diff.',
    );
  }

  const { current, record } = active;
  if (
    !current.digest ||
    record.contract !== "nevix-final-state-evidence/v2" ||
    record.baseCommit !== current.baseCommit ||
    record.finalDiff !== `sha256:${current.digest}` ||
    record.checkResult !== "PASS"
  ) {
    return block(
      input,
      "The relevant-check record is failed, stale, or malformed; rerun it after the final code edit.",
    );
  }

  let reviewEvidence;
  try {
    reviewEvidence = readFindingLedger(
      record.findingLedger || "",
      current.root,
      record,
    );
  } catch {
    reviewEvidence = null;
  }
  if (
    !reviewEvidence ||
    record.reviewedDiff !== record.finalDiff ||
    record.findingLedger !== reviewEvidence.findingLedger ||
    record.findingLedgerDigest !== reviewEvidence.findingLedgerDigest ||
    record.reviewConclusion !== reviewEvidence.reviewConclusion
  ) {
    return block(
      input,
      "Complete targeted re-review after the final code edit, then record the conclusion from a structured finding ledger with `node .codex/hooks/final-state-evidence.mjs review --ledger <code-review-findings.json>`.",
    );
  }

  const message = String(input.last_assistant_message || "");
  const acceptance = field(message, "Acceptance boundary");
  const baseCommit = field(message, "Base commit");
  const finalDiff = field(message, "Final diff");
  const relevantCheck = field(message, "Relevant check");
  const checkResult = field(message, "Check result");
  const checkCoverage = field(message, "Check coverage");
  const findingLedger = field(message, "Finding ledger");
  const findingLedgerDigest = field(message, "Finding ledger digest");
  const reviewConclusion = field(message, "Review conclusion");
  const closure = field(message, "Closure");

  const valid =
    /^Final-state evidence\s*$/im.test(message) &&
    Boolean(acceptance) &&
    baseCommit === record.baseCommit &&
    finalDiff === record.finalDiff &&
    relevantCheck === record.relevantCheck &&
    checkResult === "PASS" &&
    checkCoverage === record.checkCoverage &&
    findingLedger === record.findingLedger &&
    findingLedgerDigest === record.findingLedgerDigest &&
    reviewConclusion === record.reviewConclusion &&
    closure === "accepted";

  if (valid) return {};

  return block(
    input,
    [
      "Finish with this exact evidence shape (replace the acceptance boundary):",
      "Final-state evidence",
      "- Acceptance boundary: <behavior or risk>",
      `- Base commit: ${record.baseCommit}`,
      `- Final diff: ${record.finalDiff}`,
      `- Relevant check: ${record.relevantCheck}`,
      "- Check result: PASS",
      `- Check coverage: ${record.checkCoverage}`,
      `- Finding ledger: ${record.findingLedger}`,
      `- Finding ledger digest: ${record.findingLedgerDigest}`,
      `- Review conclusion: ${record.reviewConclusion}`,
      "- Closure: accepted",
    ].join("\n"),
  );
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value ? JSON.parse(value) : {};
}

async function main() {
  if (process.argv[2] === "check") {
    process.exitCode = runCheck(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "review") {
    process.exitCode = runReview(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "verify") {
    process.exitCode = runVerify(process.argv.slice(3));
    return;
  }
  const input = await readStdin();
  process.stdout.write(`${JSON.stringify(evaluateStop(input))}\n`);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
