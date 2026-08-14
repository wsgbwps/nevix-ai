# Final-state evidence

## Purpose

Bind a completed development task to the exact repository state that was
checked and reviewed. This extends the existing completion and handoff route;
it does not create a second issue, CI, or delivery workflow.

## Acceptance contract

For any task with a candidate diff, the acceptance record (stored under the
worktree's Git directory) binds:

- `Acceptance boundary`: the behavior or risk the task must satisfy.
- `Base commit`: the immutable commit SHA used as the candidate fixed point.
- `Final diff`: the `sha256:<digest>` emitted by the relevant-check runner.
- `Relevant check`: a stable, reader-facing check name.
- `Check result`: `PASS` for an accepted local closure.
- `Check coverage`: the behavior or risk exercised by that check.
- `Finding ledger`: the structured `code-review-findings/v1` ledger reviewed
  against the final diff and relevant check.
- `Finding ledger digest`: the ledger content digest recorded by the review
  command.
- `Review conclusion`: the ledger-derived conclusion for the current diff.
- `Closure`: `accepted` only when the evidence above covers the current diff;
  otherwise report the task as blocked without claiming completion.

The final diff digest is a binding identity, not a substitute for a readable
changed-path summary. A passing command recorded before the last code change is
stale and cannot close the task.

A candidate recorded with `--risk low` closes on check `PASS` alone: its
record carries no `Finding ledger` or `Review conclusion`, and landing skips
ledger validation. High-risk candidates (the default) keep the full review
ceremony. A low-risk record may still be upgraded by running `review` against a
structured ledger; from then on the ledger is required.
## Codex route

After the final code edit, run the task's smallest relevant check through the
repository wrapper:

```bash
node .codex/hooks/final-state-evidence.mjs check \
  --base origin/main \
  --name "<check identity>" \
  --covers "<behavior or risk covered>" \
  --boundary "<acceptance boundary>" \
  [--risk low|high] \
  [--path <task-owned changed path> ...] \
  -- <command> [args...]
```

`--boundary` is required and records the behavior or risk the task must satisfy
in the acceptance record. `--risk` defaults to `high`. Low-risk candidates
(a single dependency-only change or documentation) close without the review
ceremony; see the acceptance contract above. The wrapper refuses trivially inert
check commands (bare
`true`, `:`, or `echo`) and records the last 4096 characters of the check
output as `checkOutputTail` for auditability.

The wrapper resolves `--base` to an immutable commit, runs the command, verifies
that the candidate diff did not change while the check ran, and stores only
bounded metadata under the Git directory. The digest binds that base SHA,
changed-path set, final file contents, executable bits, symlink targets, and
deletions. It therefore remains stable when those exact contents are committed,
but an edit, omitted candidate path, or rebase invalidates it. The wrapper does
not add a repository artifact or replace normal test output. A failed check or
a changed diff requires a repair and a fresh run.
When the checkout already contains unrelated changes, repeat `--path` for every
task-owned changed file. The resulting digest covers exactly that accepted path
boundary, while each path is still verified against its live repository
content.

Review the complete final diff and relevant check together, update the existing
finding ledger, then bind that structured result to the same record:

```bash
node .codex/hooks/final-state-evidence.mjs review \
  --ledger <path-to-code-review-findings.json>
```

The review command accepts only `schema: code-review-findings/v1` with
`outcome: closed` and enforces these closure conditions:

- `currentDiffDigest`, every finding's `reviewedDiffDigest`, and the ledger's
  `relevantCheck.diffDigest` equal the wrapper's current `Final diff`.
- The ledger's final check name, result, and coverage equal the recorded check,
  and its result is `PASS`.
- Every blocker has `status: closed`, or carries explicit risk acceptance with
  non-empty ownership and rationale:

  ```json
  {
    "riskAcceptance": {
      "decision": "accepted",
      "acceptedBy": "<person-or-team>",
      "reason": "<bounded rationale>"
    }
  }
  ```

- A repaired blocker (`disposition: accepted`, `status: closed`) has at least
  one completed `targetedReviewRound` on the current digest. An empty ledger
  from a full review with no findings may retain round `0`.

The command derives the review conclusion from the validated ledger; a
`Reviewed` or `审阅` substring has no acceptance meaning. It copies the ledger
into the current worktree's Git directory, records that durable path and its
content digest, and the landing route revalidates both. A missing,
failed, or stale relevant-check record is rejected. Any later code edit
invalidates both check and review; even after rerunning the check, accepted
closure remains blocked until the current ledger has been re-reviewed and
recorded again.

## Landing enforcement

There is no conversation-end hook. Evidence is bound when the check and (for
high-risk candidates) review commands run, and enforced when the candidate
lands: `make land` calls `verify`, which snapshots the complete worktree diff
against the recorded base, requires one active record whose `--path` scope
covers every changed path, revalidates the record's digest, check result, and
review ledger, and refuses landing when any of them is missing, stale, or
malformed. Sessions may end with a dirty worktree and no record; landing is
the only place acceptance is enforced.
The remaining Codex project hooks (path protection, main push protection, and
formatters) require local trust review after their definition changes. Until
the updated hook is trusted and observed in a real turn, static config and
fixture tests prove only configuration and policy behavior, not runtime
enforcement.
