---
name: code-review
description: Review changes since a fixed point against Standards and Spec, producing a stable finding ledger; use the same Skill for targeted re-review of unresolved finding IDs after repair. Use for branch, PR, work-in-progress, or "review since X" requests.
---

Review the diff between a fixed point and the task-owned current state along two
independent axes:

- **Standards** — does the change conform to this repo's documented standards?
- **Spec** — does it faithfully implement the originating issue or spec?

Read [Finding lifecycle](references/finding-lifecycle.md) completely before
reviewing. It is the shared contract with `/implement` for IDs, state,
disposition, evidence, repair provenance, stopping, and escalation.

Choose exactly one mode:

- **Initial review** when no finding ledger exists. Run both applicable axes and
  create the ledger once.
- **Targeted re-review** when a prior ledger and repair record exist. Review only
  unresolved IDs and their repair hunks. This mode never falls back to another
  full review.

The issue tracker should have been provided to you — run
`/setup-matt-pocock-skills` if `docs/agents/issue-tracker.md` is missing.

## Shared review boundary

### 1. Pin and freeze the diff

The user-supplied commit SHA, branch, tag, or merge-base is the fixed point. If
none was supplied, ask for it. Resolve it before delegation and stop on a bad
ref.

Resolve the merge-base once. Include the task's committed, staged, and tracked
working-tree changes relative to that base; require every task-owned new file to
be tracked before freezing. Exclude unrelated dirty-worktree paths with an
explicit pathspec. Freeze the exact binary diff in an OS temporary file, compute
its `sha256:<64-hex>` digest, and record the full command, pathspec, and
`git log <fixed-point>..HEAD --oneline`. No edits may occur while reviewers read
that bundle. A missing or empty task diff stops the review.

Every finding and review result cites this digest. The final relevant check must
later bind to the current digest; a code edit makes the prior check stale.

## Initial review

### 2. Identify the spec source

Look for the originating spec in this order:

1. Issue references in commit messages; fetch them through
   `docs/agents/issue-tracker.md`.
2. A path supplied by the user.
3. A matching file under `docs/`, `specs/`, or `.scratch/`.
4. If none exists, ask where it is. If the user confirms there is no spec, skip
   the Spec agent and record `no spec available`.

### 3. Identify Standards sources

Collect repository instructions and files that govern the changed paths, such
as `AGENTS.md`, `CONTRIBUTING.md`, or `CODING_STANDARDS.md`.

The Standards axis also carries this Fowler smell baseline. The repository
overrides it, each smell is only a judgement call, and anything already enforced
by tooling is skipped:

- **Mysterious Name** — a name does not reveal what it does or holds.
- **Duplicated Code** — the same logic shape appears in multiple changed places.
- **Feature Envy** — code reaches into another object's data more than its own.
- **Data Clumps** — the same fields or parameters keep travelling together.
- **Primitive Obsession** — a primitive substitutes for a domain concept.
- **Repeated Switches** — the same type cascade recurs across the change.
- **Shotgun Surgery** — one logical change requires scattered edits.
- **Divergent Change** — one module changes for unrelated reasons.
- **Speculative Generality** — abstraction exists for an unrequested need.
- **Message Chains** — callers navigate a long object chain.
- **Middle Man** — a layer mostly delegates to the real owner.
- **Refused Bequest** — an implementer ignores most inherited behavior.

### 4. Run the independent axes in parallel

Spawn the Standards and Spec sub-agents together. They are fresh, read-only,
receive the frozen bundle rather than a live diff command, and do not delegate.

Give the Standards agent the digest, commits, Standards-source list and content,
the smell baseline above, and this brief:

> Return every documented-standard breach and material baseline smell by
> file/hunk. Cite the governing rule or name the smell, describe the observed
> consequence, propose `blocker` or `advisory`, name the smallest owner, and give
> stable identity fields: source, path-and-symbol anchor, and defect. Baseline
> smells are always advisory judgement calls; repository rules win. Skip tooling
> findings. Return candidates only, under 400 words.

Give the Spec agent the digest, commits, spec contents, and this brief:

> Return missing or partial requirements, unrequested scope, and implemented-but-
> wrong behavior. Quote the requirement, describe the observed consequence,
> propose `blocker` or `advisory`, name the smallest owner, and give stable
> identity fields: source, path-and-symbol anchor, and defect. Return candidates
> only, under 400 words.

### 5. Create the ledger once

Keep Standards and Spec findings under their original axes; do not merge or
rerank them across axes. Validate each candidate's consequence, owner, level,
evidence, and stable identity, then allocate IDs exactly as the lifecycle
reference specifies. Each initial record has `status: open`,
`disposition: pending`, the frozen digest, and
`unresolvedTargetedRounds: 0`. The reviewer records the disposition field but
does not invent the implementer or user's decision.

Set `fullReviewCount: 1`, `targetedReviewRound: 0`, and an outcome of
`needs-disposition` when any finding exists. An empty result may close only after
the final relevant check passes on the same digest.

## Targeted re-review

### 2. Validate the prior ledger

Require `schema: code-review-findings/v1`, `fullReviewCount: 1`, the prior
immutable identity fields, a repair record, and a target list containing every
and only accepted blocker in `open` or `fixed-pending-review` state. Closed,
deferred, and false-positive IDs stay in the ledger but never enter the target
list. A missing or inconsistent ledger stops for correction; it never triggers
a fresh independent review.

### 3. Review unresolved IDs and repair hunks

Group target IDs by their original axis. Spawn only the agent or agents needed
for non-empty groups, in parallel when both axes remain. Give each agent the
current frozen diff, its digest, the exact prior records, their bounded evidence,
and the repair record. Do not provide unrelated findings or ask it to rediscover
the whole diff.

The agent decides for each supplied ID whether evidence now supports `closed`
or it remains `open`, preserving the ID even when lines moved. It may report a
new problem only when the repair hunk caused it; that record gets the next ID
and the required `introducedBy` provenance. Observations outside those targets
are out of scope for this pass.

### 4. Update state and enforce the bound

Update records in place, append properly attributed repair-introduced findings,
and increment `targetedReviewRound`. Increment
`unresolvedTargetedRounds` only for an accepted blocker returned open. At two,
set that finding to `escalated`. The second targeted round is the global limit;
escalate every remaining blocker and return control to the user or named owner.
Keep `fullReviewCount: 1` throughout.

## Output

Present readable `## Standards` and `## Spec` sections, preserving the two axes,
then emit the complete machine-readable ledger. For each finding show ID, level,
disposition, owner, status, evidence, and reviewed diff digest. On targeted
re-review, also show the exact target IDs, state transitions, and any
`introducedBy` provenance.

End with counts by axis and one outcome:

- `needs-disposition`, `needs-fix`, or `needs-targeted-review` while work remains;
- `closed` only when every lifecycle stop gate holds on the final digest; or
- `escalated` with blocker IDs, owners, evidence, attempts, and checks when the
  round bound is reached.

Never replace an escalation with another full review.

## Why two axes

A change may follow every standard but implement the wrong requirement, or
implement the requirement while breaking repository conventions. Keeping the
axes separate prevents either result from masking the other; the shared ledger
adds lifecycle state without collapsing that distinction.
