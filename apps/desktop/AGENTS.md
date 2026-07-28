# Desktop code rules

- `features/A/` must not directly import internal files from `features/B/`; features communicate through `lib/` or events
- Each feature's `index.ts` is its only public export
- `components/ui/` is the default shadcn path and is treated as a shared layer; changes follow the approval rules in the root `AGENTS.md`
- `app/globals.css` is the only location for global styles
- `assets/` contains static resources only (images, SVGs, and fonts); do not place CSS or configuration files there
- Keep IPC changes domain-local: define Channel contracts in `shared/ipc/<domain>/types.ts`, register Channels in `main/ipc/<domain>/index.ts`, and place each Handler in its own file under `main/ipc/<domain>/handlers/`
- Do not add per-domain code to the preload layer or edit a central IPC registry for a domain-specific change
