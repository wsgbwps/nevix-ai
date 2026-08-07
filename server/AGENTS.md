# Server code rules

- Put every business Module under `internal/<module>/`; do not add business packages directly under `server/`
- Keep a simple Module in `internal/<module>/module.go`, and extract a Repository interface only when a second adapter is introduced
- Adopt the four layers only when the Module has the complexity described by [ADR-0003](../docs/adr/0003-complexity-driven-ddd-layering.md): entities, value objects, and Repository interfaces in `domain/`; use-case orchestration in `application/`; adapters and Repository implementations in `infrastructure/`; HTTP registration/handlers in `interface/`
- When distinct responsibility clusters emerge inside a simple Module, split them into responsibility-named sub-packages (identity: `command/` + `verification/` + `outbox/`) with `module.go` remaining the composition surface
- Keep `cmd/server/main.go` as the composition root: construct dependencies and call each Module's exported `Register(r chi.Router, bus event.Bus)` and `RunWorkers(ctx)`; never use `init()` with a blank import. The composition root and tests import only the Module package itself, never its sub-packages
- Business Modules under `internal/` must not import each other; cross-Module communication goes through the shared `internal/event/` event bus, with all Domain Event types defined centrally in `internal/event/types.go`
- Put genuinely cross-Module infrastructure in shared sub-packages under `internal/` (e.g. `internal/event`); do not create a top-level `pkg/` directory (see [ADR-0005](../docs/adr/0005-no-pkg-directory.md)). Shared sub-packages are shared areas governed by the root approval rules
