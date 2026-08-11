# Final-state evidence

## Purpose

Bind a completed development task to the exact repository state that was
checked and reviewed. This extends the existing completion and handoff route;
it does not create a second issue, CI, or delivery workflow.

## Acceptance contract

For a task with code changes, the final handoff records one `Final-state
evidence` block with:

- `Acceptance boundary`: the behavior or risk the task must satisfy.
- `Final diff`: the `sha256:<digest>` emitted by the relevant-check runner.
- `Relevant check`: a stable, reader-facing check name.
- `Check result`: `PASS` for an accepted local closure.
- `Check coverage`: the behavior or risk exercised by that check.
- `Review conclusion`: the conclusion from reviewing the final diff and the
  check result together.
- `Closure`: `accepted` only when the evidence above covers the current diff;
  otherwise report the task as blocked without claiming completion.

The final diff digest is a binding identity, not a substitute for a readable
changed-path summary. A passing command recorded before the last code change is
stale and cannot close the task.

## Codex route

After the final code edit, run the task's smallest relevant check through the
repository wrapper:

```bash
node .codex/hooks/final-state-evidence.mjs check \
  --name "<check identity>" \
  --covers "<behavior or risk covered>" \
  [--path <task-owned changed path> ...] \
  -- <command> [args...]
```

The wrapper runs the command, verifies that the code diff did not change while
the check ran, and stores only bounded metadata under the Git directory. It
does not add a repository artifact or replace normal test output. A failed
check or a changed diff requires a repair and a fresh run.
When the checkout already contains unrelated changes, repeat `--path` for every
task-owned changed file. The resulting digest covers exactly that accepted path
boundary, while each path is still verified against its live repository
content.

Review the complete final diff and the relevant check result together, then
bind that conclusion to the same record:

```bash
node .codex/hooks/final-state-evidence.mjs review \
  --conclusion "Reviewed the final diff and relevant check; <conclusion>"
```

The review command rejects a missing, failed, or stale relevant-check record.
Any later code edit invalidates both the check and review because it changes the
live digest.

At `Stop`, the existing Codex hook route compares the live code diff with the
recorded digest and the final handoff. A valid accepted handoff uses this exact
shape (values may be written in the task's language):

```text
Final-state evidence
- Acceptance boundary: <behavior or risk>
- Final diff: sha256:<digest>
- Relevant check: <check identity>
- Check result: PASS
- Check coverage: <behavior or risk covered>
- Review conclusion: <final diff and check reviewed; conclusion>
- Closure: accepted
```

Codex project hooks require local trust review after their definition changes.
Until the updated hook is trusted and observed in a real turn, static config
and fixture tests prove only configuration and policy behavior, not runtime
enforcement.
