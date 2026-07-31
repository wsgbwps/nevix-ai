# Server code rules

- Put every business Module under `internal/<module>/`; do not add business packages directly under `server/`
- Keep a simple Module in `internal/<module>/module.go` and extract a Repository interface only when a second adapter is introduced. Use the documented four layers only when the Module has the complexity described by ADR-0003
- In a layered Module, keep entities, value objects, and Repository interfaces in `domain/`; use-case orchestration in `application/`; adapters and Repository implementations in `infrastructure/`; and HTTP registration/handlers in `interface/`
- Keep `cmd/server/main.go` as the composition root: construct dependencies and call each Module's exported `Register(r chi.Router, bus event.Bus)`, but do not place business logic there or use `init()` with a blank import
- `internal/A/` must not import `internal/B/`; Modules communicate through the `pkg/event/` event bus, with all cross-Module Domain Event types defined centrally in `pkg/event/types.go`
- Put only genuinely cross-Module infrastructure in `pkg/`; it is a shared area governed by the root approval rules. Frontend/backend API contracts remain in the repository-root `contracts/`
