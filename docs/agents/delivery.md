# Delivery: verified SHA landing

`main` receives exact commits that have one local acceptance record and one
remote candidate gate. Pull requests are optional discussion artifacts; they
are not the normal delivery path.

## Task flow

1. Work on one short-lived task branch or worktree. Keep the task history
   linear and the slice independently buildable and reversible.
2. Set any task ticket to `in-verification` while the final local check or
   independent review remains open. Once both close, set it to `resolved` and
   record the local acceptance conclusion before the final commit. A ticket on
   a task branch is provisional; it becomes authoritative only when that commit
   reaches `main`.
3. Run the smallest relevant check after the last edit and bind it to
   `origin/main` through [Final-state evidence](../specs/final-state-evidence.md).
   Complete the independent review against the same base and diff. Candidates
   recorded with `--risk low` (one-line dependency or documentation changes)
   close on check `PASS` alone and skip the review ceremony.
4. Commit the complete accepted candidate. The worktree must then be clean.
5. With explicit authorization for both remote writes, run `make land`. The
   command pushes `ready/<sha>`, waits for the path-aware `CI gate`, rechecks
   `origin/main`, fast-forwards the same SHA to `main`, and removes the ready
   branch.

The GitHub check attached to the landed SHA is the remote acceptance record.
Landing also stores the SHA, CI URL, and local evidence references under the
worktree's Git directory, then clears only the active evidence pointer. Do not
copy the URL into a follow-up repository commit; that would create a new
unverified candidate.

## Failure boundaries

- A failed or cancelled candidate gate leaves `main` unchanged. Repair the task
  branch, rerun local evidence and review, then invoke `make land` again.
- If `main` advances while CI runs, rebase the task branch and repeat the local
  and remote acceptance cycle. Landing never rebases or force-pushes.
- GitHub Free cannot enforce private-branch rules server-side. The repository
  hooks prevent accidental bypass; they are not a formal compliance control.
- A visible UI change names its Playwright scenario or manual visual check in
  the acceptance coverage. Relevant Desktop candidates run the Full E2E Suite.

## Pull-request exception

Use a pull request only when another human needs a discussion or approval
surface. Delivery still promotes the reviewed exact SHA through `make land`;
do not create a new squash or merge commit in the GitHub UI.
