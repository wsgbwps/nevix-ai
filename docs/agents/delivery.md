# Delivery: pull requests and risk gates

Every tracked change uses a short-lived task branch and reaches `main` through
a pull request. Local hooks block all commits on `main` and all direct pushes
to `main`; the GitHub Free private repository has no server-side branch
protection, so agents also watch the PR checks before merging.

## Authority

Agents may investigate, implement, test, review, and commit locally on a task
branch. Stop after the local commit, report the result, and leave the branch
unpushed for user review. Push the branch and open or update a PR only when the
user explicitly asks. Opening a PR does not authorize merging it; merge only
when the user explicitly asks.

Human approval is required immediately before any high-risk external or system
action, including merging a high-risk PR. High-risk work is limited to:

- destructive or irreversible persistent-data operations;
- production deployments and releases;
- secrets, privileges, authorization, or security-boundary changes;
- paid or recurring external resources; and
- breaking public contracts.

Agents still investigate, implement, test, review, and prepare the local change
before that approval point.

## Flow

1. Work on one short-lived task branch. Keep the slice independently buildable
   and revertible, run the smallest checks that prove it, then commit locally.
   Stop and report the result for user review; leave the branch unpushed.
2. When the user explicitly asks to publish the change, push the branch and
   open or update a PR against `main` (`gh pr create --fill --base main`).
   Describe shared-area changes with their impact and tests.
3. Wait for the path-aware `CI gate` (`gh pr checks --watch --fail-fast`) and
   address failures or review findings. Desktop runtime changes run source
   Native Smoke on Windows; Main, Preload, Shared, native window/storage,
   packaging, dependency, and Native Smoke changes also run it on macOS.
   Authentication, Session, connection/TLS, security-boundary changes, and
   release candidates also require `make test-e2e` on a local Mac, recorded in
   the PR or release notes.
4. When the user explicitly asks to merge, apply the risk gate above and
   confirm the checks and review pass. For high-risk work, obtain approval
   immediately before its first external or system action, including merge.
5. Squash-merge and delete the branch (`gh pr merge --squash --delete-branch`).
   Each task lands as one commit on `main`; the PR page is its acceptance
   record.

If `main` advances while CI runs, rebase the task branch and push again so the
PR-only gate validates the updated head.
