#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Post-merge tree-SHA dedup. A squash merge onto an unmoved base reproduces
// the PR head's tree exactly, so the PR's green CI-gate run already verified
// the very content the post-merge push would re-test. When the pushed tree
// matches the merged PR's head tree and that head has a green ci-gate
// pull_request run, the duplicated product checks (desktop/server/identity)
// can be skipped on main.
//
// Every uncertain outcome fails open to skip=false — non-push event, head
// message without a "(#N)" squash reference, a moved base (trees differ),
// a missing or non-green run, or any GitHub API failure — so dedup can never
// drop verification, only ever avoid repeating it.

export function parsePullNumber(headMessage) {
  const firstLine = (headMessage ?? "").split("\n")[0] ?? "";
  const match = firstLine.match(/\(#(\d+)\)\s*$/);
  return match ? Number(match[1]) : null;
}

export async function decidePostMergeSkip({
  event,
  headMessage,
  headSha,
  repo,
  workflow = "ci-gate.yml",
  ghApi,
}) {
  if (event !== "push") {
    return { skip: false, reason: `event "${event}" is not a push` };
  }
  const pullNumber = parsePullNumber(headMessage);
  if (pullNumber === null) {
    return {
      skip: false,
      reason: "head commit message has no \"(#N)\" squash reference",
    };
  }
  try {
    const pull = await ghApi(`/repos/${repo}/pulls/${pullNumber}`);
    const prHeadSha = pull?.head?.sha;
    if (!prHeadSha) {
      return { skip: false, reason: `PR #${pullNumber} has no head sha` };
    }
    const [pushCommit, prCommit] = await Promise.all([
      ghApi(`/repos/${repo}/commits/${headSha}`),
      ghApi(`/repos/${repo}/commits/${prHeadSha}`),
    ]);
    const pushTree = pushCommit?.commit?.tree?.sha;
    const prTree = prCommit?.commit?.tree?.sha;
    if (!pushTree || !prTree || pushTree !== prTree) {
      return {
        skip: false,
        reason: `push tree ${pushTree ?? "?"} differs from PR #${pullNumber} head tree ${prTree ?? "?"} (base moved after the PR run)`,
      };
    }
    const runs = await ghApi(
      `/repos/${repo}/actions/workflows/${workflow}/runs` +
        `?event=pull_request&head_sha=${prHeadSha}` +
        `&status=completed&conclusion=success&per_page=1`,
    );
    if (!runs?.total_count) {
      return {
        skip: false,
        reason: `no green ${workflow} run on PR #${pullNumber} head ${prHeadSha.slice(0, 7)}`,
      };
    }
    return {
      skip: true,
      reason: `tree ${pushTree.slice(0, 7)} already verified green by PR #${pullNumber} (head ${prHeadSha.slice(0, 7)}, ${runs.total_count} green run${runs.total_count === 1 ? "" : "s"})`,
    };
  } catch (error) {
    return { skip: false, reason: `dedup check failed: ${error.message}` };
  }
}

export function createGhApi({ apiBaseUrl, token }) {
  return async function ghApi(path) {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status} for ${path}`);
    }
    return response.json();
  };
}

function parseArguments(args) {
  const required = ["--event", "--head-sha", "--repo"];
  const optional = ["--workflow", "--github-output"];
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (![...required, ...optional].includes(flag) || !value) {
      throw new Error(
        "usage: post-merge-dedup.mjs --event <name> --head-sha <sha> --repo <owner/name> [--workflow <file>] [--github-output <path>]",
      );
    }
    values[flag.slice(2)] = value;
  }
  for (const flag of required) {
    if (!(flag.slice(2) in values)) {
      throw new Error(`${flag} is required`);
    }
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const decision = await decidePostMergeSkip({
    event: args.event,
    headMessage: process.env.HEAD_COMMIT_MESSAGE ?? "",
    headSha: args["head-sha"],
    repo: args.repo,
    workflow: args.workflow ?? "ci-gate.yml",
    ghApi: createGhApi({
      apiBaseUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
      token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    }),
  });
  if (args["github-output"]) {
    appendFileSync(
      args["github-output"],
      `skip_verified=${decision.skip}\n`,
    );
  }
  process.stdout.write(
    `post-merge dedup: ${decision.skip ? "skip duplicate checks" : "run all checks"} — ${decision.reason}\n`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
