## Instruction routing

- Before planning or changing files under `apps/desktop/`, read `apps/desktop/AGENTS.md`; under `server/`, read `server/AGENTS.md`
- Before planning or performing development work, read and follow the `/karpathy-guidelines` skill throughout the task
- Before changes involving the trusted data plane seam (Go server API, auth, storage, push), Go trusted operations, or AI providers, read [ADR-0014](docs/adr/0014-go-sole-trusted-data-plane.md), [ADR-0015](docs/adr/0015-single-tenant-user-system-and-go-authorization.md), and [ADR-0013](docs/adr/0013-onprem-single-tenant-delivery.md); changes to their responsibility seams follow the architecture-change rules under **Shared areas and delivery**

## Directory architecture gate

- The ownership boundaries and layer descriptions in `README.md` are the canonical file-placement contract; read the area's `CONTEXT.md` and ADRs before placing files
- Before a change, name its primary Domain and the narrowest owning boundary for every new or moved source file; inside that boundary prefer a responsibility-named local directory. Do not introduce synonymous wrappers, new shared layers, or new top-level source directories
- Composition roots hold wiring only: `apps/desktop/src/main/index.ts`, renderer `app/`, and `server/cmd/server/main.go`
- If a responsibility has no canonical owner, or its placement would change a documented boundary or ADR, stop implementation and resolve it through a dedicated architecture task first
- Before completing work, check `git diff --name-status` still matches the declared Domain and canonical directories

## Shared areas and delivery

- `apps/desktop/src/renderer/src/components/ui/`, `apps/desktop/src/renderer/src/lib/`, `apps/desktop/src/renderer/src/hooks/`, `server/internal/` shared sub-packages (e.g. `internal/event`), and root `contracts/` are shared areas; call out their changes with impact and tests in the PR description
- Outside the direct-main fast lanes, one task delivers one cohesive vertical slice for one primary Domain on a short-lived task branch; no unrelated cleanup or generalized refactors
- Delivery uses PRs except for the direct-main documentation and repository-tooling fast lanes — read [docs/agents/delivery.md](docs/agents/delivery.md) before committing or pushing on `main`, opening a PR, or merging; it owns the path rules and both delivery flows
- Changes to responsibilities across contexts or modules, trusted-execution seams, or architectural decisions require an ADR before implementation — update the one whose decision changes, or write a new one when none covers it
- High-risk changes — authentication or authorization, security boundaries, public contracts such as root `contracts/`, and persistent data or migrations — require a brief written plan under `.scratch/` before implementation

## Subagent delegation

- **Parallel-ready** — a workstream is parallel-ready only when it can begin from current context, produce its assigned result without another workstream's output, and have scope, expected result, and completion criterion stated before dispatch
- **Delegation** — when decomposition yields two or more parallel-ready workstreams, delegate each to the narrowest available specialist; give each write scope a single owner
- **Context protection** — delegate exploration, research, or survey work to the narrowest read-only specialist whenever its raw output would flood the main context — many-file searches, broad codebase surveys, external research — even as a single workstream; the parent keeps only the compressed findings. Sequential or single-step work whose results fit comfortably stays in the parent

## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues through `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default GitHub triage-label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a multi-context repository; start with `CONTEXT-MAP.md`. See `docs/agents/domain.md`.
