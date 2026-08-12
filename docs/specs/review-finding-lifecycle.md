# Review Finding Lifecycle

## Purpose

Make the existing implementation review loop converge on one durable set of
findings. The initial review still evaluates Standards and Spec independently,
but every result enters one ledger that the repair and targeted re-review steps
carry forward.

The operational contract lives in
`.agents/skills/code-review/references/finding-lifecycle.md`. The two existing
Skills remain the workflow owners: `/code-review` owns review and re-review;
`/implement` owns disposition, repair, checks, and stopping.

## Acceptance boundary

- One initial review assigns immutable finding IDs and records blocking level,
  disposition, smallest owner, lifecycle status, bounded evidence, and the
  reviewed diff digest.
- Repair handles only accepted open blockers. Advisory and false-positive
  candidates receive explicit dispositions without entering the repair loop.
- Re-review receives the prior ledger and repair record, targets only unresolved
  IDs, preserves IDs when locations move, and leaves closed records closed.
- A problem introduced by a repair receives a new ID plus its causal repair and
  source finding IDs.
- Normal completion requires no unresolved blocker, a passing relevant check
  bound to the current diff digest, and a non-pending disposition for every
  non-blocking finding.
- At most two targeted re-review rounds are allowed. A blocker unresolved in
  both rounds, or any blocker still unresolved at the round limit, produces an
  escalation outcome instead of another full review.

## Non-goals

- Combining the Standards and Spec axes into one ranking.
- Treating advisory feedback as mandatory repair work.
- Replacing repository CI, human approval, or final-state evidence.
- Adding another Skill, hook, or review agent role.

## Validation

`.agents/skills/code-review/tests/review-lifecycle.fixture.json` contains one
initial ledger with a blocker, advisory, and false-positive disposition. Its
success branch closes the original blocker through a targeted re-review and
attributes a repair-introduced advisory. Its escalation branch keeps the same
blocker open for two targeted rounds.

Run:

```bash
node --test .agents/skills/code-review/tests/review-lifecycle.test.mjs
```

The fixture passes only when IDs remain stable, closed findings are neither
targeted nor recreated, repair-introduced findings have provenance, the normal
stop gate is digest-bound, and the round limit escalates without starting a new
full review.
