# Desktop code rules

## Domain ownership and IPC

- A canonical Desktop `<domain>` name is reused in every seam that Domain actually needs: `shared/ipc/<domain>/`, `main/<domain>/ipc/`, `renderer/src/features/<domain>/`, and the `<domain>:<action>` Channel prefix. Do not create empty mirror directories for absent seams
- `authentication` owns credential verification and the current-device Session lifecycle. `language` owns Language Mode and Interface Language. Do not introduce the broader `identity` name or preserve `settings` / `i18n` as competing Domain names for Language behavior
- Put IPC declarations and named request/response types in `shared/ipc/<domain>/types.ts`. Keep `preload/` generic: expose typed bridge primitives, but do not add per-Domain code or a central Domain registry
- Put each Domain-owned IPC adapter in `main/<domain>/ipc/`. Its `index.ts` only exports a synchronous `register(): void`; loading it has no side effects, registration is order-independent, and each Channel Handler lives in a directly nested `<action>.ts` file. Do not add a `handlers/` directory
- `window` is the sole platform-owner IPC exception: Window lifecycle Channels use `shared/ipc/window/types.ts`, `main/window/ipc/`, and the `window:<action>` prefix under the same registration, Handler-placement, declaration-merging, and generic-preload rules. `updater` and `tray` remain transport-free unless a later architecture decision names a required seam
- A Domain IPC adapter may depend on implementation from the same Domain; Domain implementation must not depend on IPC. Registration must not initialize storage, run migrations, perform network work, or initialize the Domain
- `main/index.ts` is a composition root. It explicitly initializes Domains through their public interfaces and auto-discovers Domain plus approved Window registration modules with `./*/ipc/index.ts`. If registration ever requires ordering, replace auto-discovery with explicit wiring rather than relying on file order
- Create `main/<domain>/index.ts` only when callers outside that Domain need a public interface. External Main callers must use it instead of deep-importing implementation; the Domain's own IPC adapter uses relative internal imports. Cross-Domain dependencies must use public interfaces and remain acyclic
- Keep platform responsibilities such as `window/`, `updater/`, and `tray/` as explicit non-Domain owners. Window lifecycle IPC does not turn `window` into a Domain; do not invent a Domain merely to make the Main tree symmetrical

## Renderer Feature interface and dependencies

- Put renderer composition, routes, providers, and `app/globals.css` in `renderer/src/app/`; `app/globals.css` is the only global stylesheet location
- Keep Domain-specific renderer code under `renderer/src/features/<domain>/`. The only TypeScript source file at a Feature root is its public `index.ts`; it contains explicit named re-exports only, with no `export *`, implementation, or initialization side effects
- Code outside a Feature imports it only through its public `index.ts`. Peer Features must not import one another, including through public indexes; compose Features in `app/`, and promote genuinely shared implementation only to an approved shared owner
- Within one Feature, implementation uses direct relative imports and does not import through its own public index. Do not impose a dependency order among sibling segments

## Renderer page ownership

- Keep `renderer/src/app/routes/` thin: a route file only creates its file route and assembles its page component, with no page implementation
- Put a page owned by a business Domain in `renderer/src/features/<domain>/`, exported through that Feature's public `index.ts`, and assembled by a thin route; per [ADR-0004](docs/adr/0004-renderer-routing-topology.md), authenticated views render in the App Shell content area except the pre-authentication routes before a Session exists (the Connection Screen and the authentication surface) and the app-owned full-screen Settings Page aggregation
- Put cross-Feature aggregation pages and pages without a Domain owner in `renderer/src/app/pages/` (e.g. the Home placeholder page)
- Keep App Shell internals in `renderer/src/app/shell/`
- Never add page files at the `renderer/src/app/` root
- Do not create a Feature named `settings` — the Settings page is owned by the app-level Settings Flow module (`app/settings/`), which composes Feature contributions and is not a Feature

## Renderer Feature segments

- Fix the public seam, dependency direction, and vocabulary; let internal directories evolve under review according to actual responsibility rather than structural symmetry
- For new general-purpose Feature segments use the Feature-Sliced vocabulary `ui/`, `api/`, `model/`, `lib/`, and `config/`. Do not create new top-level `components/`, `hooks/`, `store/`, or `types/` segments
- Place a custom hook by responsibility: business state, rules, or workflow orchestration in `model/`; interaction or presentation behavior in `ui/`; backend queries or mutations in `api/`; Feature-local technical capability in `lib/`
- A custom responsibility segment such as `session/`, `policy/`, or `i18n/` is allowed only when all three are true: its name describes a stable purpose rather than a code form or vendor; a standard segment would split its invariants, lifecycle, or knowledge and reduce locality; and the module passes the deletion test or has an owner fixed by an ADR, security requirement, or cross-runtime seam
- File count, anticipated growth, and visual symmetry do not justify a segment. State a custom segment's responsibility and why standard segments are insufficient in the PR

## Shared renderer owners

- Put reusable shadcn UI in `renderer/src/components/ui/`, shared utilities in `renderer/src/lib/`, shared hooks in `renderer/src/hooks/`, and only static images, SVGs, or fonts in `renderer/src/assets/`
- Promote code into a shared renderer owner only when it is genuinely cross-Feature, and call the change out with impact and tests per the repository shared-area rule

## Migration and enforcement

- Main Domain-first placement, Language Domain consolidation, Channel renaming, and the `./*/ipc/index.ts` glob landed as one atomic migration: no compatibility Channel aliases, second glob, or Adapter-first path
- Legacy Feature segment names migrate opportunistically when their responsibility is already changing; do not perform mechanical bulk renames. Existing legacy paths may receive necessary behavior fixes but must not become templates for new directories
- Automate deterministic path, import, public-index, registration-export, Channel-prefix, and generic-preload rules. Keep responsibility placement, interface depth, deletion tests, and migration scope as deliberate review decisions
- Any legacy allowlist must use exact paths, record a reason and removal trigger, and only shrink. A new exception to a stable seam, dependency direction, or canonical vocabulary requires a dedicated architecture task with a written plan rather than a lint disable
