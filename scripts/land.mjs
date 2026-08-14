#!/usr/bin/env node

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { verifyAcceptedCandidate } from "../.codex/hooks/final-state-evidence.mjs";

const ZERO_SHA = "0".repeat(40);

function command(
  executable,
  args,
  { cwd = process.cwd(), allowFailure = false, stdio = "pipe" } = {},
) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", stdio });
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(detail || `${executable} ${args.join(" ")} failed`);
  }
  return result;
}

function git(cwd, args) {
  return command("git", args, { cwd }).stdout.trim();
}

function repository(cwd = process.cwd()) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
  return { root, gitDir };
}

function requireClean(root) {
  if (git(root, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("landing requires a clean working tree");
  }
}

function requireIdleGitState(gitDir) {
  const inProgress = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-apply",
    "rebase-merge",
  ].find((path) => existsSync(join(gitDir, path)));
  if (inProgress) {
    throw new Error(
      `landing is unavailable during an active Git operation: ${inProgress}`,
    );
  }
}

export function inspectCandidate(cwd = process.cwd()) {
  const repo = repository(cwd);
  requireIdleGitState(repo.gitDir);
  requireClean(repo.root);

  const branchResult = command(
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { cwd: repo.root, allowFailure: true },
  );
  if (branchResult.status !== 0)
    throw new Error("landing requires a named branch");
  const branch = branchResult.stdout.trim();
  if (branch === "main")
    throw new Error("develop on a task branch before landing");

  const head = git(repo.root, ["rev-parse", "HEAD"]);
  const base = git(repo.root, ["rev-parse", "origin/main"]);
  if (head === base) throw new Error("the task branch has no commits to land");

  const ancestry = command("git", ["merge-base", "--is-ancestor", base, head], {
    cwd: repo.root,
    allowFailure: true,
  });
  if (ancestry.status !== 0) {
    throw new Error(
      "the task branch must be rebased onto the current origin/main",
    );
  }
  const merges = git(repo.root, ["rev-list", "--merges", `${base}..${head}`]);
  if (merges)
    throw new Error(
      "landing requires linear task history without merge commits",
    );

  return { ...repo, base, branch, head, readyBranch: `ready/${head}` };
}

function listRuns(cwd, head, readyBranch) {
  const result = command(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      "ci-gate.yml",
      "--commit",
      head,
      "--branch",
      readyBranch,
      "--event",
      "push",
      "--limit",
      "20",
      "--json",
      "databaseId,status,conclusion,url,headSha,headBranch",
    ],
    { cwd },
  );
  return JSON.parse(result.stdout);
}

export function matchingRuns(runs, head, readyBranch) {
  return runs
    .filter((run) => run.headSha === head && run.headBranch === readyBranch)
    .sort((left, right) => right.databaseId - left.databaseId);
}

export function requireSuccessfulRun(runs, head, readyBranch) {
  const matching = matchingRuns(runs, head, readyBranch);
  const latest = matching[0];
  if (!latest)
    throw new Error(`no CI gate exists for ${readyBranch} at ${head}`);
  if (latest.status !== "completed") {
    throw new Error(`candidate CI is still ${latest.status}: ${latest.url}`);
  }
  if (latest.conclusion !== "success") {
    throw new Error(
      `candidate CI concluded ${latest.conclusion}: ${latest.url}`,
    );
  }
  return latest;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForRun(cwd, head, readyBranch) {
  let runs = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    runs = matchingRuns(listRuns(cwd, head, readyBranch), head, readyBranch);
    if (runs.length > 0) break;
    sleep(2_000);
  }
  if (runs.length === 0) {
    throw new Error(`the CI gate did not start for ${readyBranch}`);
  }

  const latest = runs[0];
  if (latest.status !== "completed") {
    command(
      "gh",
      ["run", "watch", String(latest.databaseId), "--exit-status"],
      { cwd, stdio: "inherit" },
    );
  }
  return requireSuccessfulRun(
    listRuns(cwd, head, readyBranch),
    head,
    readyBranch,
  );
}

function remoteReadySha(root, readyBranch) {
  const output = git(root, [
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${readyBranch}`,
  ]);
  return output ? output.split(/\s+/)[0] : "";
}

export function verifyPromotion(cwd, localSha, remoteMainSha, runs) {
  if (!/^[a-f0-9]{40}$/.test(localSha) || remoteMainSha === ZERO_SHA) {
    throw new Error("main may only be updated to an existing commit");
  }
  const candidate = inspectCandidate(cwd);
  if (candidate.head !== localSha) {
    throw new Error("main may only be updated to the current accepted HEAD");
  }
  if (candidate.base !== remoteMainSha) {
    throw new Error("remote main changed after candidate verification");
  }
  const evidence = verifyAcceptedCandidate(candidate.root, remoteMainSha);
  const run = requireSuccessfulRun(runs, candidate.head, candidate.readyBranch);
  return { candidate, evidence, run };
}

export function persistLandingReceipt({ candidate, evidence, run }) {
  const path = join(
    candidate.gitDir,
    "codex-final-state-evidence",
    "landed",
    `${candidate.head}.json`,
  );
  const receipt = {
    contract: "nevix-landing-receipt/v1",
    landedCommit: candidate.head,
    baseCommit: candidate.base,
    candidateBranch: candidate.readyBranch,
    ciRunId: run.databaseId,
    ciUrl: run.url,
    finalDiff: evidence.finalDiff,
    findingLedger: evidence.findingLedger,
    findingLedgerDigest: evidence.findingLedgerDigest,
    landedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  rmSync(join(candidate.gitDir, "codex-final-state-evidence", "active.json"), {
    force: true,
  });
  return path;
}

function runVerifyPush(args) {
  if (args.length !== 2) {
    throw new Error(
      "usage: land.mjs verify-push <local-sha> <remote-main-sha>",
    );
  }
  const [localSha, remoteMainSha] = args;
  const candidate = inspectCandidate();
  const runs = listRuns(candidate.root, localSha, candidate.readyBranch);
  const verified = verifyPromotion(
    candidate.root,
    localSha,
    remoteMainSha,
    runs,
  );
  process.stdout.write(
    `verified ${verified.candidate.head} with ${verified.run.url}\n`,
  );
}

function runLand() {
  const initial = repository();
  command("gh", ["auth", "status"], {
    cwd: initial.root,
    stdio: "inherit",
  });
  command("git", ["fetch", "origin", "main"], {
    cwd: initial.root,
    stdio: "inherit",
  });

  const candidate = inspectCandidate(initial.root);
  verifyAcceptedCandidate(candidate.root, "origin/main");

  const existing = remoteReadySha(candidate.root, candidate.readyBranch);
  if (existing && existing !== candidate.head) {
    throw new Error(
      `remote ${candidate.readyBranch} points to an unexpected commit`,
    );
  }
  if (!existing) {
    command(
      "git",
      [
        "push",
        "origin",
        `${candidate.head}:refs/heads/${candidate.readyBranch}`,
      ],
      { cwd: candidate.root, stdio: "inherit" },
    );
  }

  const run = waitForRun(candidate.root, candidate.head, candidate.readyBranch);
  command("git", ["fetch", "origin", "main"], {
    cwd: candidate.root,
    stdio: "inherit",
  });
  const current = inspectCandidate(candidate.root);
  if (current.base !== candidate.base || current.head !== candidate.head) {
    throw new Error(
      "origin/main changed while candidate CI was running; rebase and verify again",
    );
  }
  const verified = verifyPromotion(
    candidate.root,
    candidate.head,
    candidate.base,
    [run],
  );

  command("git", ["push", "origin", `${candidate.head}:refs/heads/main`], {
    cwd: candidate.root,
    stdio: "inherit",
  });
  const receipt = persistLandingReceipt(verified);
  const cleanup = command(
    "git",
    ["push", "origin", "--delete", candidate.readyBranch],
    {
      allowFailure: true,
      cwd: candidate.root,
      stdio: "inherit",
    },
  );
  if (cleanup.status !== 0) {
    process.stderr.write(
      `landed ${candidate.head}, but ${candidate.readyBranch} still needs remote cleanup\n`,
    );
  }
  process.stdout.write(
    `landed ${candidate.head} on main after ${run.url}; receipt ${receipt}\n`,
  );
}

function main() {
  const commandName = process.argv[2];
  if (commandName === "land") return runLand();
  if (commandName === "verify-push")
    return runVerifyPush(process.argv.slice(3));
  throw new Error("usage: land.mjs <land|verify-push>");
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
