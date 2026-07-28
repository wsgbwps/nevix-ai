# Server code rules

- `internal/A/` must not import `internal/B/`; modules communicate through the `pkg/event/` event bus
- Define all event types centrally in `pkg/event/types.go`
- Each module exports `Register(r chi.Router, bus event.Bus)`, which is called explicitly in `main.go`; do not use `init()` with a blank import
- Keep simple modules in a single file; extract a repository interface only when a second adapter is introduced
