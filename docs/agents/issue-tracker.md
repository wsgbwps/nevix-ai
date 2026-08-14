# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` — never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Branch wrap-up checklist

When implementation on a branch is complete, close it out in this order. Remote verification and landing are external write operations and require explicit user authorization; this checklist only fixes the steps and where the acceptance record lives.

1. **Resolve the candidate ticket** — set `Status: resolved` and append the local acceptance conclusion before freezing the candidate. The state becomes authoritative only when its commit reaches `main`.
2. **Bind the final local state** — record the acceptance boundary, base, final diff, and relevant check through [Final-state evidence](../specs/final-state-evidence.md), plus the review conclusion for high-risk changes. The check must run after the last edit.
3. **Commit the accepted candidate** — keep the task history linear and the working tree clean. Do not add a post-landing ticket commit.
4. **Land the exact SHA** — follow [Verified SHA landing](delivery.md). `make land` confirms the remote candidate gate and fast-forwards `main` without creating a merge commit.
5. **Delete the task branch when convenient** — the landing command removes its temporary `ready/<sha>` branch; local task-branch cleanup remains a separate recoverable operation.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
