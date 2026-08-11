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

When implementation on a branch is complete, close it out in this order. Merging, pushing, and deleting remote branches are external write operations — each one still requires explicit user authorization every time; this checklist only fixes the steps and where the acceptance record lives.

1. **Bind the final local state** — for code changes, record the acceptance boundary, final diff, relevant check and review conclusion through [Final-state evidence](../specs/final-state-evidence.md). The check must run after the last code edit.
2. **Confirm CI is green** — the Desktop CI workflow (`.github/workflows/desktop-ci.yml`) must pass on the PR before merging.
3. **Merge per the repo's delivery rules** — high-risk changes land through a branch and PR gated by CI and diff review; all other work may go directly to `main` (see the delivery workflow in the root `AGENTS.md`).
4. **Delete the merged branch** — remove the local branch (`git branch -d <branch>`) and, with authorization, the remote branch.
5. **Resolve the ticket** — in the `.scratch/<feature-slug>/issues/<NN>-<slug>.md` file, set `Status: resolved` and append the acceptance conclusion (what was verified and how, e.g. final-state evidence, CI run, tests, review outcome) under the `## Comments` heading.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
