# Finding lifecycle

Use one ledger from initial review through completion or escalation. Treat its
finding IDs as primary keys, not labels to regenerate on each pass.

## Ledger contract

The ledger has these top-level fields:

- `schema`: `code-review-findings/v1`.
- `fixedPoint`, `scopePaths`, and `currentDiffDigest`: the exact review boundary.
- `fullReviewCount`: `1` after the initial review and immutable thereafter.
- `targetedReviewRound`: `0` initially, then `1` or `2`.
- `findings`: the append-only finding records below. Records may change state;
  IDs and identity fields do not change.
- `repairRecords`: one entry per accepted-blocker repair batch.
- `relevantCheck`: the final check name, result, coverage, and diff digest, or
  `null` before it runs.
- `outcome`: `needs-disposition`, `needs-fix`, `needs-targeted-review`, `closed`,
  or `escalated`.

Every finding contains:

```json
{
  "id": "CR-STANDARDS-0001",
  "axis": "standards",
  "identity": {
    "owner": "path/or-team",
    "source": "standard-or-requirement",
    "anchor": "path-and-symbol",
    "defect": "stable-defect-description"
  },
  "level": "blocker",
  "disposition": "pending",
  "dispositionReason": "",
  "owner": "path/or-team",
  "status": "open",
  "evidence": [],
  "reviewedDiffDigest": "sha256:<64-hex>",
  "unresolvedTargetedRounds": 0,
  "introducedBy": null
}
```

`level` is `blocker` or `advisory`. A blocker is limited to behavior, security,
data, public-contract, test, or documented-architecture breakage that prevents
acceptance. Everything else is advisory.

`disposition` is:

- `pending`: no owner decision yet.
- `accepted`: a blocker accepted for repair in the current scope.
- `deferred`: an advisory acknowledged outside the blocker loop.
- `false-positive`: rejected with counter-evidence in `dispositionReason`.

`status` is `open`, `fixed-pending-review`, `closed`, or `escalated`. Only a
finding with `level: blocker`, `disposition: accepted`, and `status: open` is
repair-eligible. A repair changes it to `fixed-pending-review`; only targeted
re-review changes that state to `closed` or back to `open`. A false-positive or
deferred finding is `closed` for this loop. Pending dispositions never satisfy
the stop gate.

`owner` is the smallest canonical repository path that can repair the issue, or
a named human/team when no code owner can decide it. Evidence is a bounded list
of source, path/symbol or hunk, observed consequence, and check references.
Line numbers may be evidence but never identity.

## Stable IDs and identity

During initial aggregation, sort candidates within each axis by owner, source,
anchor, and defect; allocate `CR-STANDARDS-0001` or `CR-SPEC-0001` upward. Once
emitted, an ID is immutable and never reused. Standards and Spec records remain
separate even when they describe related behavior.

Targeted re-review matches the prior `identity` and carries the old ID forward.
A changed line number, repair hunk, status, evidence set, or diff digest does not
create a new finding. Closed records remain in the ledger and are excluded from
all later target lists.

A distinct problem first observed inside a repair hunk gets the next unused ID
for its axis and must set:

```json
{
  "introducedBy": {
    "kind": "repair",
    "findingIds": ["CR-STANDARDS-0001"],
    "repairDiffDigest": "sha256:<64-hex>"
  }
}
```

Without this provenance, report the observation as unverified repair risk and
escalate it; do not silently add an unattributed finding.

## Repair and targeted re-review

Before editing, disposition every record. Accepted blockers form the only fix
queue. Each repair batch appends a record with `fixFor`, the before/after diff
digests, touched paths/hunks, and affected check results. Set those blockers to
`fixed-pending-review`.

Targeted re-review receives the prior ledger, current diff bundle, and repair
record. It examines only:

1. unresolved IDs in `open` or `fixed-pending-review` state; and
2. the repair hunks for regressions attributable through `introducedBy`.

It updates existing records in place. An unresolved accepted blocker returns to
`open` and increments `unresolvedTargetedRounds`. At `2`, set it to `escalated`.
Increment `targetedReviewRound` once per pass and keep `fullReviewCount: 1`.
The second targeted round is the global limit: any blocker still unresolved at
that point escalates, even if it was introduced during repair. Escalation ends
the agent loop and asks the user or named owner for a decision; it never starts
a new full Standards or Spec review.

## Stop gate

Set `outcome: closed` only when all conditions hold on the same current diff:

- no blocker is `open`, `fixed-pending-review`, or `escalated`;
- every advisory has disposition `deferred` or `false-positive` and status
  `closed`;
- every false-positive has counter-evidence;
- the final relevant check reports `PASS` and its diff digest equals
  `currentDiffDigest`; and
- the final diff and check result have been reviewed together as required by
  the repository's final-state evidence route; low-risk candidates
  (documentation or a single dependency-only change) close on check `PASS` alone
  without a review ledger, as that route defines.

Set `outcome: escalated` when the round bound is reached with an unresolved
blocker. Return the blocker IDs, owners, evidence, attempted repairs, and failed
or unavailable checks; do not claim normal completion.
