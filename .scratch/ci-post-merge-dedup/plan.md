# Plan: post-merge tree-SHA dedup for the CI gate

## Problem

The merge push re-runs the gate on `main`. E2E is already skipped by design
("the PR already validated the same tree"), but Server CI (~40s) and Identity
Integration CI (~5.5min) re-verify content that the merged PR's green gate run
just verified byte-for-byte. Delivery is squash-only and linear, so a squash
merge onto an unmoved base reproduces the PR head's tree exactly.

## Change (one vertical slice, harness domain)

- `scripts/post-merge-dedup.mjs` — decides `skip_verified` for the push event:
  push head message carries a `(#N)` squash reference → PR #N head sha →
  `tree(push commit) == tree(PR head)` → a green `ci-gate.yml` pull_request run
  exists on that head ⇒ skip. Everything else fails open to false.
- `scripts/tests/post-merge-dedup.test.mjs` — node:test coverage for every
  branch incl. CLI fail-open subprocess test; wired into `make harness-test`.
- `.github/workflows/ci-gate.yml` — dedup step in the changes job (needs
  contents/pull-requests/actions read); desktop/server/identity jobs gain
  `skip_verified != 'true'`; the gate treats dedup-skipped checks as satisfied.
- `scripts/classify-ci-changes.mjs` — the two new files classify harness-only
  (delivery-machinery self-changes, same group as ci-gate.yml).
- `docs/agents/delivery.md` — step 5 documents the dedup and its fail-open.

## Safety argument

tree(squash) == tree(PR head) ⟹ the PR head content-wise contains the
pre-push main tip ⟹ the green run's merge-ref tree equals tree(PR head)
(main is linear squash-only, so the run's base is an ancestor of the tip)
⟹ the skipped checks re-verified exactly the pushed content. Any mismatch,
missing green run, or API error fails open to a full post-merge run; dedup
can never drop verification, only avoid repeating it. E2E stays PR-only.

## Verification

- Unit tests (all dedup branches) + classifier group test, via
  `make harness-test`.
- End-to-end against real repository data (PRs #62/#63/#64): squash trees
  equal PR head trees; green-run lookup returns the expected runs; the CLI
  with PR #64's real merge message decides `skip=true`.
- The PR for this change runs the full harness path; its own merge push is
  the first live dedup execution (observed before calling it done).
