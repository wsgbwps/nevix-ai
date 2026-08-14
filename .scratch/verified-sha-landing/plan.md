# Verified SHA landing harness

Primary Domain: repository delivery governance.

Owner boundaries:

- `scripts/` owns changed-path classification and the local landing command.
- `.codex/` and `.husky/` own agent and Git misuse guards.
- `.github/workflows/` owns candidate-SHA verification.
- `docs/agents/` and `docs/specs/` own the durable delivery contract.

## Decision

1. Every task is completed on a short-lived branch and reviewed against
   `origin/main`.
2. `make land` is the only normal route to `main`. It verifies local evidence,
   pushes the exact commit to `ready/<sha>`, waits for one path-aware remote CI
   gate, rechecks the base, then fast-forwards `main` to the same SHA.
3. Relevant candidate changes run the Full E2E Suite. Specialized workflows do
   not rerun on the resulting `main` push.
4. Git hooks prevent accidental bypass on GitHub Free. They are local quality
   controls, not server-enforced compliance controls.
5. Pull requests are optional discussion artifacts, not the normal landing
   mechanism.

## Acceptance

- A failed or cancelled candidate run leaves `main` unchanged.
- A concurrent update to `main` invalidates the candidate and stops landing.
- Local evidence remains valid across committing the reviewed tree, but an edit
  or changed base invalidates it.
- Every path is classified; an unknown path makes the candidate gate fail.
- A relevant Desktop candidate runs one Full E2E Suite and no duplicate main
  suite.
- Landing uses no force push.

## Bootstrap

This governance change uses the repository's existing pull-request route once.
After the old gate passes, the same branch commit is exercised through the new
candidate route and fast-forwarded with `make land`.
