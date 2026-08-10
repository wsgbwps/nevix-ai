## Instruction routing

- Before planning or changing files under `apps/desktop/`, read `apps/desktop/AGENTS.md`; under `server/`, read `server/AGENTS.md`. For work spanning both areas, read both before planning
- Before planning or performing development work, read and follow the `/karpathy-guidelines` skill throughout the task
- Before changes involving Supabase, Go trusted operations, Storage, Realtime, Webhooks, PostgreSQL access, or AI providers, read [ADR-0004](docs/adr/0004-supabase-go-trusted-execution-seam.md); changes to its responsibility seam follow the architecture-change rules under **Shared areas and delivery workflow**

## Directory architecture gate

- Treat the ownership boundaries and layer descriptions in `README.md` as the canonical file-placement contract; its Domain-local leaf directories are representative rather than exhaustive. Read the area's `CONTEXT.md` and ADRs before placing files
- Before proposing or implementing a change, name its primary Domain and identify the narrowest owning boundary for every new or moved source file
- Inside that boundary, choose or create a responsibility-named local directory when it keeps a distinct concern cohesive. Do not introduce synonymous wrappers, new shared layers, or new top-level source directories to mirror a personal convention
- Keep composition roots limited to wiring: `apps/desktop/src/main/index.ts`, renderer `app/`, and `server/cmd/server/main.go` hold no business logic
- If a responsibility has no canonical owner, or its placement would change a documented boundary or ADR, stop implementation and surface the conflict. Resolve it through a dedicated architecture task before adding another convention
- Before completing development work, inspect `git diff --name-status` and verify that every changed path still matches the declared Domain and canonical directory. Call out required shared-area or composition-root changes with their impact and tests

## Shared areas and delivery workflow

- `apps/desktop/src/renderer/src/components/ui/`, `apps/desktop/src/renderer/src/lib/`, `apps/desktop/src/renderer/src/hooks/`, `server/internal/` shared sub-packages (e.g. `internal/event`), and root `contracts/` are shared areas. Call out their changes with impact and tests in the commit or PR description; no separate approval is required
- Contributors and AI agents may work autonomously inside the task's primary Domain while preserving documented boundaries. They must not perform unrelated cleanup or generalized refactors, or change a public API without a written plan
- One task delivers one cohesive vertical slice for one primary Domain, landing through a feature branch and PR
- A vertical slice may include its renderer Feature, domain-local IPC contracts and Handlers, domain-local implementation, and narrowly scoped supporting changes such as composition-root wiring, tests, dependencies, or build configuration
- High-risk changes — authentication or authorization, security boundaries, public contracts such as root `contracts/`, and persistent data or migrations — require a short written plan under `.scratch/` before implementation, and must land through a branch and PR so CI and diff review gate the merge
- CI-gated paths — `apps/`, `server/`, `supabase/`, `contracts/`, `scripts/`, `.github/`, and root build manifests (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `go.work`, `go.work.sum`) — land through a feature branch and PR so CI gates the merge, and require no written plan; the repository PreToolUse hook blocks direct commits to `main` for these paths
- Docs and local dev tooling — `docs/`, `.scratch/`, root `Makefile`, root-level Markdown, `.qoder/`, `.codex/` — may be committed directly to `main`: every CI workflow path-filters on the gated paths above, so a PR for these files runs no checks
- A task may update its local issue and documentation to record implemented behavior within documented responsibilities, but must not introduce or revise an architectural responsibility or boundary without the documentation required by the next rule
- Changes to responsibilities across contexts or modules, trusted-execution seams such as Supabase-to-Go, repository-wide architecture rules, or architectural decisions require a written plan and updated documentation (ADR where warranted) before implementation
- When high-risk work is split into multiple PRs, each PR must independently build, test, merge, and roll back without incomplete behavior or temporary compatibility scaffolding

## Subagent delegation

- **Parallel-ready** — A workstream is parallel-ready only when it can begin from the current context and produce its assigned result without another workstream's output, and its scope, expected result, and checkable completion criterion can be stated before dispatch
- **Delegation** — When subagents are available and decomposition yields two or more parallel-ready workstreams, delegate each to the narrowest available specialist; use a general-purpose subagent when no specialist fits. Keep sequential and single-step work in the parent
- **Coordination** — Run parallel-ready read-only work concurrently, give each write scope a single owner, and state every handoff's scope, expected result, completion criterion, and wait policy

## Agent skills

- **Issue tracker** — tickets are local markdown under `.scratch/<feature-slug>/`. Read `docs/agents/issue-tracker.md` when a skill publishes or fetches tickets, or when wrapping up a branch
- **Triage labels** — read `docs/agents/triage-labels.md` before writing a ticket `Status:` line
- **Domain docs** — read `docs/agents/domain.md` before exploring a Domain or naming domain concepts; it routes to `CONTEXT-MAP.md`, per-context `CONTEXT.md`, and ADRs
