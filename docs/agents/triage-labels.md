# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Local state extensions

The five canonical state roles do not cover the full lifecycle of a local-markdown ticket. This repo additionally uses:

- `in-review` — implementation is complete and a PR is open awaiting merge. When the PR merges, the ticket MUST be normalized to `resolved` with the PR link and merge evidence preserved in the `Status:` line. Never close merged work as `done` or `merged`.
- `resolved` — terminal state for merged work, per the branch wrap-up checklist in `issue-tracker.md`.
- Wayfinding states `open` / `claimed` / `resolved` — only on `/wayfinder` map tickets, per `issue-tracker.md`.
- Superseded tickets — label `wontfix` and record the superseding decision directly in the `Status:` line.
