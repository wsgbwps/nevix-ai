## Code rules

### Frontend (apps/desktop/)

- `features/A/` must not directly import internal files from `features/B/`; features communicate through `lib/` or events
- Each feature's `index.ts` is its only public export
- `components/ui/` is the default shadcn path and is treated as a shared layer; changes require additional review
- `app/globals.css` is the only location for global styles
- `assets/` contains static resources only (images, SVGs, and fonts); do not place CSS or configuration files there
- Keep IPC changes domain-local: define Channel contracts in `shared/ipc/<domain>/types.ts`, register Channels in `main/ipc/<domain>/index.ts`, and place each Handler in its own file under `main/ipc/<domain>/handlers/`
- Do not add per-domain code to the preload layer or edit a central IPC registry for a domain-specific change

### Backend (server/)

- `internal/A/` must not import `internal/B/`; modules communicate through the `pkg/event/` event bus
- Define all event types centrally in `pkg/event/types.go`
- Each module exports `Register(r chi.Router, bus event.Bus)`, which is called explicitly in `main.go`; do not use `init()` with a blank import
- Keep simple modules in a single file; extract a repository interface only when a second adapter is introduced

### Supabase and Go architecture

- Before planning, implementing, or reviewing changes involving Supabase, Go trusted operations, Storage, Realtime, Webhooks, PostgreSQL access, or AI providers, read and follow [ADR-0004](docs/adr/0004-supabase-go-trusted-execution-seam.md)
- Do not change the Supabase-to-Go responsibility seam inside a feature PR; create a separate architecture ticket and update ADR-0004 first

### Shared areas

- `components/ui/`, `lib/`, and `pkg/` are shared areas; changes require additional review
- By default, one implementation PR delivers one cohesive vertical slice for one primary Domain
- A vertical slice may include its renderer Feature, domain-local IPC contracts and Handlers, and domain-local implementation under `main/ipc/<domain>/`
- Necessary composition-root wiring, shared infrastructure, tests, dependencies, and build or packaging configuration are allowed exceptions only when the PRD or ticket names each exceptional area, explains why it is required, and the implementation PR requires and receives additional review before merge
- An implementation PR may include its `.scratch/<feature-slug>/` PRD and local issue updates, plus feature-local documentation that describes the slice's implemented behavior
- An implementation PR may update an ADR or `CONTEXT.md` only to record implemented behavior within already approved responsibilities and boundaries; it must not introduce or revise a responsibility or boundary
- A separate architecture ticket and documentation-only architecture PR are required before implementation only when a change alters responsibilities across contexts or modules, changes an established trusted-execution seam such as Supabase-to-Go, modifies repository-wide architecture constraints or development rules, or introduces a new architectural decision through an ADR or `CONTEXT.md`
- Split work into multiple PRs only when each resulting PR can independently build, test, merge, and roll back without incomplete behaviour or temporary compatibility scaffolding
- A documentation-only architecture PR may instead change project guidance, Context documents, ADRs, README, and its local issue; it must not include schema, API, Electron, Go, cloud-resource, or provider-adapter implementation

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
