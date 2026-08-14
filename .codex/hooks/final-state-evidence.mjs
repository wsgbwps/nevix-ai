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
import { spawn, spawnSync } from "node:child_process";
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

function repository(cwd = process.cwd()) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const rawGitDir = git(root, ["rev-parse", "--git-dir"]).trim();
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(root, rawGitDir);
  return { root, gitDir };
}

function resolveCommit(root, ref) {
  return git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
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
  const changedPaths = [...new Set([...tracked, ...untracked])].sort();
  const paths = pathScope ? [...new Set(pathScope)].sort() : changedPaths;

  if (
    paths.some(
      (path) =>
        !changedPaths.includes(path) ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").includes(".."),
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

function reviewedMarkerPath(state, finalDiff) {
  if (!DIGEST_PATTERN.test(finalDiff)) {
    throw new Error("invalid final diff identity");
  }
  return join(
    state.gitDir,
    "codex-final-state-evidence",
    "reviewed",
    `${finalDiff.slice("sha256:".length)}.json`,
  );
}

function readReviewedMarker(state, finalDiff) {
  const path = reviewedMarkerPath(state, finalDiff);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
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
  let boundary = "";
  let risk = "high";
  const paths = [];
  let index = 0;

  while (index < args.length && args[index] !== "--") {
    const flag = args[index];
    const value = args[index + 1];
    if (
      (flag === "--base" ||
        flag === "--name" ||
        flag === "--covers" ||
        flag === "--boundary" ||
        flag === "--risk" ||
        flag === "--path") &&
      value
    ) {
      if (flag === "--base") base = value.trim();
      if (flag === "--name") name = value.trim();
      if (flag === "--covers") covers = value.trim();
      if (flag === "--boundary") boundary = value.trim();
      if (flag === "--risk") risk = value.trim();
      if (flag === "--path") paths.push(value.trim());
      index += 2;
      continue;
    }
    throw new Error(`unknown or incomplete option: ${flag}`);
  }

  if (
    !base ||
    !name ||
    !covers ||
    !boundary ||
    args[index] !== "--" ||
    !args[index + 1]
  ) {
    throw new Error(
      "usage: final-state-evidence.mjs check --base <fixed-point> --name <identity> --covers <behavior-or-risk> --boundary <acceptance-boundary> [--risk low|high] [--path <task-path> ...] -- <command> [args...]",
    );
  }
  if (name.length > 160 || covers.length > 400 || boundary.length > 400) {
    throw new Error("check identity, coverage, or boundary is too long");
  }
  if (risk !== "low" && risk !== "high") {
    throw new Error("--risk must be low or high");
  }

  return {
    base,
    name,
    covers,
    boundary,
    risk,
    paths,
    command: args[index + 1],
    commandArgs: args.slice(index + 2),
  };
}

const DEPENDENCY_ONLY_KEYS = new Set([
  "packageManager",
  "engines",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions",
  "pnpm",
]);

function isDependencyOnlyPackageJsonChange(baseCommit, root) {
  let base;
  let current;
  try {
    base = JSON.parse(git(root, ["show", `${baseCommit}:package.json`]));
    current = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return false;
  }
  const changedKeys = [
    ...new Set([...Object.keys(base), ...Object.keys(current)]),
  ].filter((key) => JSON.stringify(base[key]) !== JSON.stringify(current[key]));
  return changedKeys.length === 1 && DEPENDENCY_ONLY_KEYS.has(changedKeys[0]);
}

function assertLowRiskEligible({ baseCommit, root, paths }) {
  const ineligible = paths.filter((path) => {
    if (path.startsWith("docs/") || path.endsWith(".md")) return false;
    if (path === "package.json") {
      return !isDependencyOnlyPackageJsonChange(baseCommit, root);
    }
    return true;
  });
  if (ineligible.length > 0) {
    throw new Error(
      `--risk low requires documentation or a single dependency-only change; ineligible paths: ${ineligible.join(", ")}`,
    );
  }
}

function runCheckCommand(command, commandArgs, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
    });
    const MAX_TAIL = 4096;
    let tail = "";
    const sink = (chunk, stream) => {
      stream.write(chunk);
      tail = `${tail}${chunk.toString("utf8")}`.slice(-MAX_TAIL);
    };
    child.stdout.on("data", (chunk) => sink(chunk, process.stdout));
    child.stderr.on("data", (chunk) => sink(chunk, process.stderr));
    child.on("error", (error) => {
      tail = `${tail}${error.message}`.slice(-MAX_TAIL);
      resolve({ status: null, tail });
    });
    child.on("close", (status) => resolve({ status, tail }));
  });
}

async function runCheck(args) {
  const parsed = parseCheckArguments(args);
  if (
    ["true", ":", "echo"].includes(parsed.command) &&
    parsed.commandArgs.length === 0
  ) {
    throw new Error("refusing a trivial no-op check command");
  }
  const before = snapshot(
    process.cwd(),
    parsed.paths.length > 0 ? parsed.paths : null,
    parsed.base,
  );
  if (!before.digest) {
    throw new Error("no candidate diff to bind");
  }
  if (parsed.risk === "low") {
    assertLowRiskEligible(before);
  }

  const result = await runCheckCommand(
    parsed.command,
    parsed.commandArgs,
    before.root,
  );
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
    acceptanceBoundary: parsed.boundary,
    risk: parsed.risk,
    relevantCheck: parsed.name,
    checkResult: status,
    checkCoverage: parsed.covers,
    checkOutputTail: result.tail,
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
    record.checkResult !== "PASS" ||
    typeof record.acceptanceBoundary !== "string" ||
    !record.acceptanceBoundary.trim()
  ) {
    throw new Error("the relevant-check record is failed, stale, or malformed");
  }

  const evidence = persistFindingLedger(
    current,
    readFindingLedger(args[1], current.root, record),
  );
  const marker = {
    finalDiff: record.finalDiff,
    findingLedgerDigest: evidence.findingLedgerDigest,
    reviewedAt: new Date().toISOString(),
  };
  const markerPath = reviewedMarkerPath(current, record.finalDiff);
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
    mode: 0o600,
  });
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
    typeof record.acceptanceBoundary !== "string" ||
    !record.acceptanceBoundary.trim()
  ) {
    throw new Error("the accepted evidence is failed, stale, or malformed");
  }
  const hasReview = Boolean(record.findingLedger && record.reviewedDiff);
  if (!hasReview) {
    if (readReviewedMarker(current, record.finalDiff)) {
      throw new Error(
        "this diff was previously reviewed; the finding ledger is required",
      );
    }
    if (record.risk !== "low") {
      throw new Error("the accepted evidence is failed, stale, or malformed");
    }
    return;
  }
  if (record.reviewedDiff !== record.finalDiff) {
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



async function main() {
  if (process.argv[2] === "check") {
    process.exitCode = await runCheck(process.argv.slice(3));
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
  throw new Error(
    "usage: final-state-evidence.mjs <check|review|verify> [args...]",
  );
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
