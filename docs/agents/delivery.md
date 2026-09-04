# Delivery: direct-main fast lanes and pull requests

Pure documentation and repository-tooling changes may be committed and pushed
directly to `main` without a pull request or CI. All other work reaches `main`
through pull requests. The GitHub Free private repository has no server-side
branch protection, so local hooks enforce this boundary and PR checks are
watched locally before merging.

## Direct-main fast lanes

A tracked path is eligible for a direct-main fast lane when it is either:

- documentation: an `*.md` file at any depth or a file inside any `docs/`
  directory, including context-scoped ADRs and documentation assets; or
- repository tooling: a file inside `.pi/`, `.codex/`, `.agents/`, `.omp/`,
  `.scratch/`, `.zcode/`, `.codegraph/`, `.github/`, or `.husky/`; the root `.mcp.json`,
  `skills-lock.json`, or `.gitignore`; or one of the delivery-harness files
  `scripts/classify-ci-changes.mjs`,
  `scripts/tests/classify-ci-changes.test.mjs`,
  `scripts/post-merge-dedup.mjs`, and
  `scripts/tests/post-merge-dedup.test.mjs`.

Fast-lane changes may be committed on `main` and pushed directly; they skip
the CI gate through `paths-ignore`, and no PR or CI run is required. The
commit is still the delivery checkpoint: stop after committing, and push only
when the user explicitly asks. Before pushing, confirm the complete commit
and push range contains only fast-lane paths; documentation and
repository-tooling paths may be mixed. A change that includes any other path
must use the PR flow below.

## Pull-request flow

1. Work on one short-lived task branch. Keep the slice independently buildable
   and revertible. The commit on the task branch is the implementation
   hand-off: stop there and leave the branch unpushed.
2. Only after the user has verified the committed work and explicitly asks,
   push the branch and open a PR against `main` (`gh pr create --fill --base
   main`). Describe shared-area changes with their impact and tests in the PR
   body.
3. Wait for the path-aware `CI gate`: `gh pr checks --watch --fail-fast`.
   Desktop runtime changes run source Native Smoke on Windows; Main, Preload,
   Shared, native window/storage, packaging, dependency, and Native Smoke
   changes also run it on macOS. Desktop documentation, `test-results/`, and
   unit/component tests do not start a Native Smoke job. Authentication,
   Session, connection/TLS, security-boundary changes, and release candidates
   also require `make test-e2e` on a local Mac, with the result recorded in the
   PR or release notes.
4. Squash-merge and delete the branch: `gh pr merge --squash --delete-branch`.
   Each task lands as exactly one commit on `main`; the PR page is its
   acceptance record.
5. The merge push runs the gate once on `main`. When the squash commit
   reproduces the merged PR's head tree exactly and that head has a green gate
   run, tree-SHA dedup (`scripts/post-merge-dedup.mjs`) skips desktop/server as
   already verified; otherwise they run as classified. Dedup fails open: a
   moved base, a missing green run, or an API error runs the classified
   post-merge gate. A failed post-merge run is repaired by a follow-up PR or a
   revert PR.

## Notes

- If `main` advances while CI runs, rebase the task branch and push; the gate
  reruns on the updated head.
- GitHub Free cannot enforce required checks server-side; the local watch step
  is the actual gate. Rapid successive merges can cancel an in-flight
  post-merge run; the superseding run still validates its own merge diff.
