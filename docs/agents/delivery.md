# Delivery: pull requests and risk gates

Every tracked change uses a short-lived task branch and reaches `main` through
a pull request. Local hooks block all commits on `main` and all direct pushes
to `main`; the GitHub Free private repository has no server-side branch
protection, so agents also watch the PR checks before merging.

## Authority

Agents may investigate, implement, test, commit locally, push the task branch,
open or update its PR, address review, wait for CI, and merge low- or
medium-risk work without another checkpoint. An explicit user instruction
always narrows this default; for example, “do not push yet” stops the flow
after the local commit.

Human approval is required immediately before any high-risk external or system
action, including merging a high-risk PR. High-risk work is limited to:

- destructive or irreversible persistent-data operations;
- production deployments and releases;
- secrets, privileges, authorization, or security-boundary changes;
- paid or recurring external resources; and
- breaking public contracts.

Agents still investigate, implement, test without changing high-risk external
or system state, review, and prepare the PR before that approval point.

## Flow

1. Work on one short-lived task branch. Keep the slice independently buildable
   and revertible, then run the smallest checks that prove it.
2. Commit, push the branch, and open a PR against `main` (`gh pr create --fill
   --base main`). Describe shared-area changes with their impact and tests.
3. Wait for the path-aware `CI gate` (`gh pr checks --watch --fail-fast`) and
   address failures or review findings. Desktop runtime changes run source
   Native Smoke on Windows; Main, Preload, Shared, native window/storage,
   packaging, dependency, and Native Smoke changes also run it on macOS.
   Authentication, Session, connection/TLS, security-boundary changes, and
   release candidates also require `make test-e2e` on a local Mac, recorded in
   the PR or release notes.
4. Apply the risk gate above. Merge low- and medium-risk work when its checks
   and review pass; for high-risk work, pause immediately before its first
   external or system action, including merge.
5. Squash-merge and delete the branch (`gh pr merge --squash --delete-branch`).
   Each task lands as one commit on `main`; the PR page is its acceptance
   record.
6. A merge push admitted by the current workflow path filters runs the gate on
   `main`. When the squash commit reproduces the merged PR head tree and that
   head has a green gate run,
   `scripts/post-merge-dedup.mjs` skips desktop/server as already verified.
   Dedup fails open: a moved base, missing green run, or API error runs the
   classified post-merge gate. Repair a failure with a follow-up or revert PR.

If `main` advances while CI runs, rebase the task branch and push again. Rapid
successive merges can cancel an in-flight post-merge run; the superseding run
still validates its own merge diff.
