## Code rules

### Frontend (apps/desktop/)

- `features/A/` must not directly import internal files from `features/B/`; features communicate through `lib/` or events
- Each feature's `index.ts` is its only public export
- `components/ui/` is the default shadcn path and is treated as a shared layer; changes require additional review
- `app/globals.css` is the only location for global styles
- `assets/` contains static resources only (images, SVGs, and fonts); do not place CSS or configuration files there
- When adding an IPC handler, change only the two files under its domain: `shared/ipc/<domain>/types.ts` and `main/ipc/<domain>/index.ts`; do not modify shared files
- The preload layer contains no per-domain code, so adding a domain does not require editing it

### Backend (server/)

- `internal/A/` must not import `internal/B/`; modules communicate through the `pkg/event/` event bus
- Define all event types centrally in `pkg/event/types.go`
- Each module exports `Register(r chi.Router, bus event.Bus)`, which is called explicitly in `main.go`; do not use `init()` with a blank import
- Keep simple modules in a single file; extract a repository interface only when a second adapter is introduced

### Shared areas

- `components/ui/`, `lib/`, and `pkg/` are shared areas; changes require additional review
- A single PR may change only `features/<name>/`, `ipc/<name>/`, `internal/<name>/`, and `contracts/<name>.yaml`

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
