# Desktop code rules

- A Desktop Domain uses the same `<domain>` name across `shared/ipc/<domain>/`, `main/ipc/<domain>/`, and `renderer/src/features/<domain>/`
- Put IPC declarations and named request/response types in `shared/ipc/<domain>/types.ts`, registration only in `main/ipc/<domain>/index.ts`, and each Handler in its own file directly under `main/ipc/<domain>/`
- Keep `preload/` generic: expose typed bridge primitives, but do not add per-Domain code or a central Domain registry
- Put renderer composition, routes, providers, and `app/globals.css` in `renderer/src/app/`; it is the only global stylesheet location and contains no Feature business logic
- Keep Domain-specific renderer code under `renderer/src/features/<domain>/`. At the Feature root, keep only the public `index.ts` file; implementation belongs in `components/`, `hooks/`, `api/`, and the optional `store/`
- `features/A/` must not directly import internal files from `features/B/`; consumers may import only from another Feature's `index.ts`
- Promote code to `lib/`, shared `hooks/`, or events only when it is genuinely cross-Feature and the root shared-area approval rule is satisfied
- Put reusable shadcn components in `renderer/src/components/ui/`, shared utilities in `renderer/src/lib/`, shared hooks in `renderer/src/hooks/`, and only static images, SVGs, or fonts in `renderer/src/assets/`
