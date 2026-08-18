import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  decidePostMergeSkip,
  parsePullNumber,
} from "../post-merge-dedup.mjs";

const REPOSITORY = join(import.meta.dirname, "../..");

const REPO = "owner/repo";
const PUSH_SHA = "pushsha";
const PR_HEAD = "prheadsha";
const RUNS_PATH =
  `/repos/${REPO}/actions/workflows/ci-gate.yml/runs` +
  `?event=pull_request&head_sha=${PR_HEAD}&status=completed&conclusion=success&per_page=1`;

// ghApi stub: routes by exact path; unseen paths throw like an unexpected
// request so tests assert which lookups actually happen.
function ghApiRouting(responses) {
  const seen = [];
  const ghApi = async (path) => {
    seen.push(path);
    const respond = responses[path];
    if (!respond) {
      throw new Error(`unexpected GitHub API path: ${path}`);
    }
    return respond();
  };
  return { ghApi, seen };
}

function mergeRoutes({
  pullHead = PR_HEAD,
  pushTree = "tree1",
  prTree = "tree1",
  greenRuns = 2,
} = {}) {
  return {
    [`/repos/${REPO}/pulls/64`]: () => ({ head: { sha: pullHead } }),
    [`/repos/${REPO}/commits/${PUSH_SHA}`]: () => ({
      commit: { tree: { sha: pushTree } },
    }),
    [`/repos/${REPO}/commits/${PR_HEAD}`]: () => ({
      commit: { tree: { sha: prTree } },
    }),
    [RUNS_PATH]: () => ({ total_count: greenRuns }),
  };
}

function decide({ event = "push", headMessage = "feat: x (#64)", ...rest }) {
	const routing = ghApiRouting(mergeRoutes(rest));
	return decidePostMergeSkip({
		event,
		headMessage,
		headSha: PUSH_SHA,
		repo: REPO,
		ghApi: routing.ghApi,
	}).then((decision) => ({ ...decision, seen: routing.seen }));
}

test("parsePullNumber reads the squash reference from the title line only", () => {
  assert.equal(parsePullNumber("feat(identity): 全部写事务 (#64)"), 64);
  assert.equal(parsePullNumber("feat(identity): x (#64)\n\nbody (#999)"), 64);
  assert.equal(parsePullNumber("Merge pull request #64 from feat/x"), null);
  assert.equal(parsePullNumber("no reference"), null);
  assert.equal(parsePullNumber(undefined), null);
});

test("non-push events never skip and never call the API", async () => {
  const decision = await decide({ event: "pull_request" });
  assert.equal(decision.skip, false);
  assert.deepEqual(decision.seen, []);
});

test("a head message without a squash reference never skips", async () => {
  const decision = await decide({ headMessage: "direct commit" });
  assert.equal(decision.skip, false);
  assert.deepEqual(decision.seen, []);
});

test("a green PR run on an identical tree skips as already verified", async () => {
  const decision = await decide({ greenRuns: 2 });
  assert.equal(decision.skip, true);
  assert.match(decision.reason, /PR #64/);
  assert.match(decision.reason, /2 green runs/);
});

test("a moved base (tree mismatch) never skips and skips the run lookup", async () => {
  const decision = await decide({
    pushTree: "tree1",
    prTree: "tree2",
  });
  assert.equal(decision.skip, false);
  assert.match(decision.reason, /differs/);
  assert.ok(!decision.seen.includes(RUNS_PATH));
});

test("no green gate run on the PR head never skips", async () => {
  const decision = await decide({ greenRuns: 0 });
  assert.equal(decision.skip, false);
  assert.match(decision.reason, /no green ci-gate\.yml run/);
});

test("a PR without a head sha never skips", async () => {
  const decision = await decide({ pullHead: null });
  assert.equal(decision.skip, false);
});

test("API failures fail open to running every check", async () => {
  const routing = ghApiRouting({
    [`/repos/${REPO}/pulls/64`]: () => {
      throw new Error("GitHub API 503");
    },
  });
  const decision = await decidePostMergeSkip({
    event: "push",
    headMessage: "feat: x (#64)",
    headSha: PUSH_SHA,
    repo: REPO,
    ghApi: routing.ghApi,
  });
  assert.equal(decision.skip, false);
  assert.match(decision.reason, /dedup check failed/);
});

test("the CLI exits 0 and writes skip_verified=false when the API is unreachable", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "post-merge-dedup-test-"));
  const outputPath = join(outputDir, "github_output");
  const stdout = execFileSync(
    process.execPath,
    [
      join(REPOSITORY, "scripts/post-merge-dedup.mjs"),
      "--event",
      "push",
      "--head-sha",
      PUSH_SHA,
      "--repo",
      REPO,
      "--github-output",
      outputPath,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_API_URL: "http://127.0.0.1:1",
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        HEAD_COMMIT_MESSAGE: "feat: x (#64)",
      },
    },
  );
  assert.match(stdout, /run all checks/);
  assert.match(stdout, /dedup check failed/);
  assert.equal(readFileSync(outputPath, "utf8"), "skip_verified=false\n");
  rmSync(outputDir, { recursive: true, force: true });
});
