# Delivery: pull requests

`main` receives work through pull requests. The GitHub Free private
repository has no server-side branch protection, so the PR checks are watched
locally before merging; local hooks block direct `main` commits and pushes
that fall outside the config/docs fast lane.

## Config and docs fast lane

Changes confined to `.pi/`, `.codex/`, `.agents/`, `.omp/`, `.scratch/`,
`docs/`, root-level `*.md` files, and the nested `AGENTS.md` files
(`apps/desktop/AGENTS.md`, `server/AGENTS.md`) may be committed and pushed
directly to `main`. The push skips the CI gate (`paths-ignore`), and the
local hooks allow it only when every tracked change in the push stays inside
those paths. A push that mixes them with anything else must go through a PR.

## Task flow

1. Work on one short-lived task branch. Keep the slice independently buildable
   and revertible.
2. Push the branch and open a PR against `main` (`gh pr create --fill --base
   main`). Describe shared-area changes with their impact and tests in the PR
   body.
3. Wait for the path-aware `CI gate`: `gh pr checks --watch --fail-fast`. PRs
   run smoke E2E when e2e-relevant paths change.
4. Squash-merge and delete the branch: `gh pr merge --squash --delete-branch`.
   Each task lands as exactly one commit on `main`; the PR page is its
   acceptance record.
5. The merge push runs the gate once on `main` (desktop/server/identity as
   classified; never E2E — the PR already validated the same tree). A failed
   post-merge run is repaired by a follow-up PR or a revert PR. When a change
   needs the Full E2E Suite (auth/session/security-sensitive UI), label the
   PR `full-e2e` before merging, or run the suite manually via
   `workflow_dispatch`.

## Notes

- If `main` advances while CI runs, rebase the task branch and push; the gate
  reruns on the updated head.
- GitHub Free cannot enforce required checks server-side; the local watch step
  is the actual gate. Rapid successive merges can cancel an in-flight
  post-merge run; the superseding run still validates its own merge diff.
