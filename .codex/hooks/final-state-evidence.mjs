#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT_CODE_FILES = new Set([
  "go.work",
  "go.work.sum",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
]);
const CODE_PREFIXES = [
  ".codex/hooks/",
  ".github/",
  "apps/",
  "contracts/",
  "scripts/",
  "server/",
  "supabase/",
];
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

function isCodePath(path) {
  return (
    ROOT_CODE_FILES.has(path) ||
    CODE_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
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

export function snapshot(cwd = process.cwd(), pathScope = null) {
  const repo = repository(cwd);
  const tracked = new Set(
    zeroDelimited(
      git(repo.root, ["diff", "--name-only", "-z", "HEAD", "--"], null),
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
    !paths.some(isCodePath)
  ) {
    return { ...repo, digest: null, paths: [] };
  }

  const hash = createHash("sha256");
  hash.update("nevix-final-state-evidence/v1\0");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    if (untracked.has(path)) {
      hash.update("untracked\0");
      hash.update(readFileSync(join(repo.root, path)));
    } else {
      hash.update("tracked\0");
      hash.update(
        git(
          repo.root,
          ["diff", "--binary", "--no-ext-diff", "HEAD", "--", path],
          null,
        ),
      );
    }
    hash.update("\0");
  }

  return { ...repo, digest: hash.digest("hex"), paths };
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
    `${JSON.stringify({ finalDiff: record.finalDiff, paths: record.paths }, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

function readActive(cwd = process.cwd()) {
  const repo = repository(cwd);
  if (!existsSync(activePath(repo))) return null;

  try {
    const pointer = JSON.parse(readFileSync(activePath(repo), "utf8"));
    if (!Array.isArray(pointer.paths)) return null;
    const path = recordPath(repo, pointer.finalDiff);
    if (!existsSync(path)) return null;

    const record = JSON.parse(readFileSync(path, "utf8"));
    return { current: snapshot(repo.root, pointer.paths), record };
  } catch {
    return null;
  }
}

function parseCheckArguments(args) {
  let name = "";
  let covers = "";
  const paths = [];
  let index = 0;

  while (index < args.length && args[index] !== "--") {
    const flag = args[index];
    const value = args[index + 1];
    if (
      (flag === "--name" || flag === "--covers" || flag === "--path") &&
      value
    ) {
      if (flag === "--name") name = value.trim();
      if (flag === "--covers") covers = value.trim();
      if (flag === "--path") paths.push(value.trim());
      index += 2;
      continue;
    }
    throw new Error(`unknown or incomplete option: ${flag}`);
  }

  if (!name || !covers || args[index] !== "--" || !args[index + 1]) {
    throw new Error(
      "usage: final-state-evidence.mjs check --name <identity> --covers <behavior-or-risk> [--path <task-path> ...] -- <command> [args...]",
    );
  }
  if (name.length > 160 || covers.length > 400) {
    throw new Error("check identity or coverage is too long");
  }

  return {
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
  );
  if (!before.digest) {
    throw new Error("no code diff to bind");
  }

  const result = spawnSync(parsed.command, parsed.commandArgs, {
    cwd: before.root,
    stdio: "inherit",
  });
  const after = snapshot(before.root, before.paths);
  const exitCode = Number.isInteger(result.status) ? result.status : 1;
  const unchanged = before.digest === after.digest;
  const status =
    exitCode === 0 && unchanged ? "PASS" : unchanged ? "FAIL" : "STALE";
  const record = {
    contract: "nevix-final-state-evidence/v1",
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
      "code diff changed while the check ran; rerun after the final edit\n",
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
    ledger.fullReviewCount !== 1 ||
    !Number.isInteger(ledger.targetedReviewRound) ||
    ledger.targetedReviewRound < 0 ||
    !Array.isArray(ledger.findings) ||
    ledger.outcome !== "closed"
  ) {
    throw new Error("finding ledger is malformed or not closed");
  }
  if (ledger.currentDiffDigest !== record.finalDiff) {
    throw new Error("finding ledger does not match the current diff digest");
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
    if (finding.level !== "blocker") continue;

    blockers.push(finding);
    const risk = finding.riskAcceptance;
    const acceptedRisk =
      risk?.decision === "accepted" &&
      typeof risk.acceptedBy === "string" &&
      Boolean(risk.acceptedBy.trim()) &&
      typeof risk.reason === "string" &&
      Boolean(risk.reason.trim());
    if (finding.status === "closed") {
      if (finding.disposition === "accepted") repairedBlockerCount += 1;
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
    record.contract !== "nevix-final-state-evidence/v1" ||
    record.finalDiff !== `sha256:${current.digest}` ||
    record.checkResult !== "PASS"
  ) {
    throw new Error("the relevant-check record is failed, stale, or malformed");
  }

  const evidence = readFindingLedger(args[1], current.root, record);
  const reviewedRecord = {
    ...record,
    ...evidence,
    reviewedDiff: record.finalDiff,
    reviewedAt: new Date().toISOString(),
  };
  writeRecord(current, reviewedRecord);
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
  const changed = snapshot(cwd);
  if (!changed.digest) return {};

  const active = readActive(cwd);
  if (!active) {
    return block(
      input,
      'Run the relevant check after the final code edit with `node .codex/hooks/final-state-evidence.mjs check --name "<identity>" --covers "<behavior or risk>" -- <command> [args...]`, then review the final diff.',
    );
  }

  const { current, record } = active;
  if (
    !current.digest ||
    record.contract !== "nevix-final-state-evidence/v1" ||
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
  const input = await readStdin();
  process.stdout.write(`${JSON.stringify(evaluateStop(input))}\n`);
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
