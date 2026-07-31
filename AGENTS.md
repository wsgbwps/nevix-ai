## Instruction routing

- Before planning or changing files under `apps/desktop/`, read `apps/desktop/AGENTS.md`
- Before planning or changing files under `server/`, read `server/AGENTS.md`
- For work spanning both areas, read both files before planning the change

## Repository-wide code rules

### Mandatory development guidelines

- Before planning or performing development work, AI agents must read and follow the `/karpathy-guidelines` skill throughout the task.

### Directory architecture gate

- Treat the ownership boundaries and layer descriptions in `README.md` as the canonical file-placement contract; its Domain-local leaf directories are representative rather than exhaustive. Also follow `docs/agents/domain.md` to read the relevant Context and ADRs, then apply the relevant nested `AGENTS.md`
- Before proposing or implementing a change, name its primary Domain and identify the narrowest owning boundary for every new or moved source file
- Inside that boundary, choose or create a responsibility-named local directory when it keeps a distinct concern cohesive. Do not introduce synonymous wrappers, new shared layers, or new top-level source directories to mirror a personal convention
- Keep composition roots limited to wiring. Business logic does not belong in `apps/desktop/src/main/index.ts`, renderer `app/`, or `server/cmd/server/main.go`
- If a responsibility has no canonical owner, or its placement would change a documented boundary or ADR, stop implementation and surface the conflict. Resolve it through a dedicated architecture task before adding another convention
- Before completing development work, inspect `git diff --name-status` and verify that every changed path still matches the declared Domain and canonical directory. Call out required shared-area or composition-root changes with their impact and tests

### Supabase and Go architecture

- Treat [ADR-0004](docs/adr/0004-supabase-go-trusted-execution-seam.md) as mandatory context for changes involving Supabase, Go trusted operations, Storage, Realtime, Webhooks, PostgreSQL access, or AI providers; changes to its responsibility seam follow the architecture-change rules under **Shared areas and delivery workflow**

### Shared areas and delivery workflow

- `apps/desktop/src/renderer/src/components/ui/`, `apps/desktop/src/renderer/src/lib/`, `apps/desktop/src/renderer/src/hooks/`, `server/pkg/`, and root `contracts/` are shared areas. Call out their changes with impact and tests in the commit or PR description; no separate approval is required
- Contributors and AI agents may work autonomously inside the task's primary Domain while preserving documented boundaries. They must not perform unrelated cleanup or generalized refactors, or change a public API without a written plan
- One task delivers one cohesive vertical slice for one primary Domain, whether it lands as direct commits to `main` or through a PR
- A vertical slice may include its renderer Feature, domain-local IPC contracts and Handlers, domain-local implementation, and narrowly scoped supporting changes such as composition-root wiring, tests, dependencies, or build configuration
- High-risk changes — authentication or authorization, security boundaries, public contracts such as root `contracts/`, and persistent data or migrations — require a short written plan under `.scratch/` before implementation, and must land through a branch and PR so CI and diff review gate the merge
- All other work may be committed and pushed directly to `main`; no branch, PR, or written plan is required
- A task may update its local issue and documentation to record implemented behavior within documented responsibilities, but must not introduce or revise an architectural responsibility or boundary without the documentation below
- Changes to responsibilities across contexts or modules, trusted-execution seams such as Supabase-to-Go, repository-wide architecture rules, or architectural decisions require a written plan and updated documentation (ADR where warranted) before implementation
- When high-risk work is split into multiple PRs, each PR must independently build, test, merge, and roll back without incomplete behavior or temporary compatibility scaffolding

## Agent skills

### Issue tracker

Local markdown — issues live as `.scratch/<feature-slug>/` files. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context — `CONTEXT-MAP.md` at root points to per-context `CONTEXT.md` files in `apps/desktop/` and `server/`. See `docs/agents/domain.md`.
