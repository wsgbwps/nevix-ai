# Issue tracker: GitHub

GitHub Issues are the canonical tracker for this repository. Use the `gh` CLI for all tracker operations.

Supporting plans and analysis may remain under `.scratch/<feature-slug>/` when required by repository policy, but they are not tracker records; link them to the relevant GitHub issue.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, also fetching labels when needed.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically inside this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The map is one GitHub issue with child issues as tickets.

- **Map**: create one issue labelled `wayfinder:map`.
- **Child ticket**: link it as a GitHub sub-issue; where unavailable, use a task list and `Part of #<map>` in the child. Apply `wayfinder:<type>` labels.
- **Blocking**: use GitHub native issue dependencies; where unavailable, use a `Blocked by: #<n>` line.
- **Claim**: `gh issue edit <n> --add-assignee @me`.
- **Resolve**: comment with the answer, close the issue, then add the context pointer to the map.
