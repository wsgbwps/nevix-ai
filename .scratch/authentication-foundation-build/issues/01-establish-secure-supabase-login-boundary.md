# 01 — Establish the Secure Supabase Login Boundary

**What to build:** A user can launch the built Desktop app, see a localized unauthenticated boundary, sign in with a real Supabase email/password identity, enter the existing minimal app shell, and sign out of the current runtime. This first tracer also establishes the disposable Auth test lane and the Electron security boundary required before renderer Auth traffic is allowed.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## UI sources and constraints

- Use the shadcn `login-02` Block as the visual starting point.
- Before applying generated content, run `npx shadcn@latest add login-02 --dry-run` and `npx shadcn@latest add login-02 --diff`, review both outputs, then add it without `--overwrite`.
- Treat generated page/router placement as disposable scaffolding. Adapt the useful form and layout into the Authentication Feature and expose that Feature only through its public entry point.
- Use the [Supabase React Password-Based Authentication Block](https://supabase.com/ui/docs/react/password-based-auth) only to cross-check Auth API interaction, loading/submission state and error-handling cases.
- Do not copy the reference Block's SPA routes, location redirects, redirect-based recovery, Magic Link paths, independently created Supabase client, or raw provider error rendering.
- If the shadcn diff proposes additions or edits in the shared UI layer, record the exact shared primitives affected, their consumers and tests, then perform the required deliberate self-review and maintainer approval before merge. Do not overwrite an existing primitive.
- Move every user-visible string introduced by the Block or implementation into Simplified Chinese and English i18n resources; generated English literals are not final product copy.

## Acceptance criteria

- [ ] The Supabase JavaScript client is pinned to a reviewed exact version and the lockfile is committed.
- [ ] Desktop accepts only the configured Supabase API URL and publishable key; missing or invalid public configuration fails explicitly without rendering an apparently usable app.
- [ ] No secret/service-role key, PostgreSQL credential, JWT private key or SMTP credential enters the Desktop build, renderer environment, logs, traces or screenshots.
- [ ] A documented, bounded command starts a version-pinned disposable local Supabase Auth stack with Mailpit, builds Desktop, runs the Auth Playwright scope with one worker, and always cleans up local services and test data.
- [ ] The test fixture creates or seeds a login-capable User outside the Desktop process; the built Desktop then signs in through the public Auth interface with email and password.
- [ ] Startup renders a blocking authentication initialization state before selecting the unauthenticated boundary; the existing app content is reachable only after successful sign-in.
- [ ] Unknown email, unverified email and wrong password produce the same localized “email or password is incorrect” outcome, while request submission disables duplicate actions.
- [ ] Successful sign-in creates only an in-memory Session for this ticket and enters the minimal authenticated app shell; closing and reopening Desktop intentionally returns to login until ticket 03 is complete.
- [ ] Current-runtime sign-out explicitly uses current-session/local scope, clears the in-memory Session and returns to the unauthenticated boundary.
- [ ] BrowserWindow explicitly enables sandbox, context isolation and web security, disables Node integration, and exposes no Authentication-specific preload API.
- [ ] CSP allows only the exact configured Supabase Auth HTTP/HTTPS origin needed by this slice; wildcard, generic schemes and unused WS/WSS origins are absent.
- [ ] Top-level navigation, new windows, arbitrary external opening and renderer permission requests are denied by default.
- [ ] Playwright verifies the final BrowserWindow preferences, allowed and blocked CSP connections, navigation/window/permission denial, login, app-shell gating and current-runtime sign-out through the built Electron app.
- [ ] Authentication copy and resource-contract coverage pass in both Simplified Chinese and English, including live Interface Language changes supported by the existing app.
- [ ] Lint, node/web typecheck, build and the ticket's Electron Playwright tests pass without introducing Profile, Organization, business schema, RLS, Go Identity code, a shared Auth package or unrelated refactoring.

