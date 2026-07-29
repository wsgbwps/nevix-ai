## Instruction routing

- Before planning or changing files under `apps/desktop/`, read `apps/desktop/AGENTS.md`
- Before planning or changing files under `server/`, read `server/AGENTS.md`
- For work spanning both areas, read both files before planning the change

## Repository-wide code rules

### Mandatory development guidelines

- Before planning or performing development work, AI agents must read and follow the `/karpathy-guidelines` skill throughout the task.

### Directory architecture gate

- Treat the directory structure and layer descriptions in `README.md` as the canonical file-placement contract; also follow `docs/agents/domain.md` to read the relevant Context and ADRs, then apply the relevant nested `AGENTS.md`
- Before proposing or implementing a change, name its primary Domain and map every new or moved source file to an existing canonical directory from `README.md`
- Put code in the narrowest existing directory that owns the responsibility. Do not introduce synonymous directories, wrapper layers, or new top-level source directories to mirror a personal convention
- Keep composition roots limited to wiring. Business logic does not belong in `apps/desktop/src/main/index.ts`, renderer `app/`, or `server/cmd/server/main.go`
- If a responsibility has no canonical location, or the current tree conflicts with `README.md` or an ADR, stop implementation and surface the conflict. Resolve the documentation through an approved architecture task before adding another convention
- Before completing development work, inspect `git diff --name-status` and verify that every changed path still matches the declared Domain and canonical directory. Call out required shared-area or composition-root changes with their impact and tests

### Supabase and Go architecture

- Treat [ADR-0004](docs/adr/0004-supabase-go-trusted-execution-seam.md) as mandatory context for changes involving Supabase, Go trusted operations, Storage, Realtime, Webhooks, PostgreSQL access, or AI providers; changes to its responsibility seam follow the architecture-change rules under **Shared areas and change approval**

### Shared areas and change approval

- `apps/desktop/src/renderer/src/components/ui/`, `apps/desktop/src/renderer/src/lib/`, `apps/desktop/src/renderer/src/hooks/`, `server/pkg/`, and root `contracts/` are shared areas. Their changes must be called out with impact and tests, and require repository-maintainer approval before merge; for maintainer-authored work, deliberate self-review is sufficient
- Contributors and AI agents may work autonomously inside the task's primary Domain while preserving documented boundaries. They must not perform unrelated cleanup or generalized refactors, or change a public API without an approved plan
- By default, one implementation PR delivers one cohesive vertical slice for one primary Domain
- A vertical slice may include its renderer Feature, domain-local IPC contracts and Handlers, domain-local implementation, and narrowly scoped supporting changes such as composition-root wiring, tests, dependencies, or build configuration
- Small, backward-compatible shared changes may ship with the vertical slice. Changes to public contracts, authentication or authorization, persistent data, security boundaries, or multiple Domains require a written plan and repository-maintainer approval before implementation
- An implementation PR may update its local issue and documentation to record implemented behavior within already approved responsibilities, but must not introduce or revise an architectural responsibility or boundary
- Changes to responsibilities across contexts or modules, trusted-execution seams such as Supabase-to-Go, repository-wide architecture rules, or architectural decisions require a separate architecture task and repository-maintainer approval before implementation; a separate documentation PR is optional
- Split work into multiple PRs only when each PR can independently build, test, merge, and roll back without incomplete behavior or temporary compatibility scaffolding

## Agent skills

### Issue tracker

Local markdown — issues live as `.scratch/<feature-slug>/` files. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context — `CONTEXT-MAP.md` at root points to per-context `CONTEXT.md` files in `apps/desktop/` and `server/`. See `docs/agents/domain.md`.

## Context protection

Protect the primary agent's context from large or unpredictable output. Delegate noisy,
read-heavy exploration to the built-in `explorer` agent or another suitable read-only
subagent, and ask it to return a concise summary with relevant file references.

### Delegate to a subagent

- Broad or recursive searches without a file-type, result-count, or directory bound
- `find` over large directories without `-maxdepth`
- `git log` without `-n`, `--max-count`, or `--oneline` limits
- Web searches, page fetches, or commands whose output size is unpredictable
- Exploratory searches where the target is not yet known

### Safe to run in the primary agent

- Read a file at a known path
- Run build, test, lint, or typecheck commands
- Run a targeted search with a narrow directory, file glob, result-count, or files-only output
- Run `git log` with an explicit limit
- Run `git diff --stat` or `git show --stat`
- Run `find` with `-maxdepth` or within a narrow directory
- Run a command whose output is confidently bounded to roughly 30 lines
