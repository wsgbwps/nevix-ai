---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Before editing, name the acceptance boundary, fixed point, primary Domain, and
task-owned paths. Read and follow
[`../code-review/references/finding-lifecycle.md`](../code-review/references/finding-lifecycle.md)
for the shared review ledger and bounded repair loop.

Use `/tdd` where possible at pre-agreed seams. Run typechecking and focused tests
regularly, then the relevant full suite once before initial review. Freeze every
task-owned new file as a tracked path so `/code-review` can review the complete
diff; preserve unrelated working-tree changes.

## Review and repair loop

1. Invoke `/code-review` once in initial mode with the fixed point, spec source,
   and exact task-owned pathspec. Keep its complete `code-review-findings/v1`
   ledger; this is the only full review.
2. Disposition every finding with evidence. A blocker becomes `accepted` for
   current-scope repair or `false-positive` with counter-evidence. An advisory
   becomes `deferred` or `false-positive`. Leave no `pending` disposition before
   deciding the next action.
3. Fix only findings with `level: blocker`, `disposition: accepted`, and
   `status: open`. Do not repair advisory or false-positive records inside this
   convergence loop.
4. After each accepted-blocker batch, rerun affected checks, compute the new diff
   digest, append a repair record (`fixFor`, before/after digests, touched
   paths/hunks, checks), and set repaired IDs to `fixed-pending-review`.
5. Invoke `/code-review` in targeted mode with the prior ledger and repair
   record. Pass only unresolved IDs. Preserve old IDs; keep closed records out of
   the target list. A new problem in a repair hunk must carry `introducedBy`
   provenance to the causal repair and finding IDs.
6. Repeat repair plus targeted re-review only while the lifecycle contract
   permits it. After two targeted rounds, or when the same blocker remains
   unresolved in both, set the outcome to `escalated`, show the user the IDs,
   owners, evidence, attempts, and checks, and stop. Never start another full
   independent review.

## Completion

Normal completion requires all lifecycle stop gates: no unresolved or escalated
blocker; every advisory and false-positive has an explicit closed disposition;
the final relevant check passes on the current diff digest; and the final diff
and check result are reviewed together under the repository's final-state
evidence route.

When the gate closes, report the final ledger outcome and commit the accepted
diff to the current branch. When the outcome is `escalated`, do not claim
completion or commit it as accepted work; return control to the user or named
owner with the bounded evidence.
