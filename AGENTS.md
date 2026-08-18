## Instruction routing

- Before planning or changing files under `apps/desktop/`, read `apps/desktop/AGENTS.md`; under `server/`, read `server/AGENTS.md`. For work spanning both areas, read both before planning
- Before planning or performing development work, read and follow the `/karpathy-guidelines` skill throughout the task
- Before changes involving Supabase, Go trusted operations, Storage, Realtime, Webhooks, PostgreSQL access, or AI providers, read [ADR-0004](docs/adr/0004-supabase-go-trusted-execution-seam.md); changes to its responsibility seam follow the architecture-change rules under **Shared areas and delivery**

## Directory architecture gate

- The ownership boundaries and layer descriptions in `README.md` are the canonical file-placement contract; read the area's `CONTEXT.md` and ADRs before placing files
- Before a change, name its primary Domain and the narrowest owning boundary for every new or moved source file; inside that boundary prefer a responsibility-named local directory. Do not introduce synonymous wrappers, new shared layers, or new top-level source directories
- Composition roots hold wiring only: `apps/desktop/src/main/index.ts`, renderer `app/`, and `server/cmd/server/main.go`
- If a responsibility has no canonical owner, or its placement would change a documented boundary or ADR, stop implementation and resolve it through a dedicated architecture task first
- Before completing work, check `git diff --name-status` still matches the declared Domain and canonical directories

## Shared areas and delivery

- `apps/desktop/src/renderer/src/components/ui/`, `apps/desktop/src/renderer/src/lib/`, `apps/desktop/src/renderer/src/hooks/`, `server/internal/` shared sub-packages (e.g. `internal/event`), and root `contracts/` are shared areas; call out their changes with impact and tests in the PR description
- One task delivers one cohesive vertical slice for one primary Domain on a short-lived task branch; no unrelated cleanup or generalized refactors
- Delivery is PR-based: push the branch, open a PR against `main`, wait for the path-aware `CI gate`, then squash-merge — see [docs/agents/delivery.md](docs/agents/delivery.md)
- Changes to responsibilities across contexts or modules, trusted-execution seams, or architectural decisions require an updated ADR where warranted, before implementation
- High-risk changes — authentication or authorization, security boundaries, public contracts such as root `contracts/`, and persistent data or migrations — require a brief written plan under `.scratch/` before implementation

## Subagent delegation

- **Parallel-ready** — a workstream is parallel-ready only when it can begin from current context, produce its assigned result without another workstream's output, and have scope, expected result, and completion criterion stated before dispatch
- **Delegation** — when decomposition yields two or more parallel-ready workstreams, delegate each to the narrowest available specialist; give each write scope a single owner; keep sequential and single-step work in the parent

## Agent skills

- **Delivery** — read `docs/agents/delivery.md` before pushing a branch, opening a PR, or merging
- **Issue tracker** — tickets are local markdown under `.scratch/<feature-slug>/`; read `docs/agents/issue-tracker.md` when publishing or fetching tickets, or wrapping up a branch
- **Triage labels** — read `docs/agents/triage-labels.md` before writing a ticket `Status:` line
- **Domain docs** — read `docs/agents/domain.md` before exploring a Domain or naming domain concepts; it routes to `CONTEXT-MAP.md`, per-context `CONTEXT.md`, and ADRs
