# Verify a candidate SHA once, then fast-forward main

Nevix AI uses short-lived task branches and promotes an exact commit only after
its local evidence, review ledger, and path-aware remote CI gate agree. This
keeps the quality signal previously carried by pull requests while avoiding a
second expensive run after merge; on the current GitHub Free private repository,
local hooks prevent accidental bypass but are not treated as server-enforced
compliance controls.

## Consequences

- `make land` is the normal path to `main`; pull requests remain optional for
  human discussion.
- Relevant candidate commits run the Full E2E Suite, while ordinary `main`
  pushes do not rerun specialized CI.
- The Git directory retains a per-SHA landing receipt that binds the remote CI
  URL to the local evidence and finding-ledger digests.
- A future protected-branch migration can retain the same candidate SHA and CI
  contract while moving enforcement from local hooks to GitHub.
