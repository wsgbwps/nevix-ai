# 04 — Deliver Isolated Password Recovery and Close Authentication Foundation

**What to build:** A user who forgot their password can request a recovery code without revealing whether the email exists, verify the six-digit code in Desktop, choose a new password through an isolated recovery Session, return to login, and use the new password while old refresh Sessions can no longer refresh. Completing this tracer also closes the full Authentication Foundation acceptance gate.

**Blocked by:** 02 — Deliver Email Signup and Six-Digit Verification; 03 — Persist and Restore the Current-Device Session Securely.

**Status:** ready-for-agent

## UI sources and constraints

- Reuse the visual language and reviewed primitives established by the login and signup tracers; do not install a separate recovery Block or create another Authentication boundary.
- Use the [Supabase React Password-Based Authentication Block](https://supabase.com/ui/docs/react/password-based-auth) only to cross-check reset request, loading/submission state, password update interaction and relevant error cases.
- Explicitly reject the reference Block's SPA routes, location redirects, redirect-based recovery link, Magic Link behavior, standalone normal Supabase client and raw provider error display.
- Recovery must remain the spec-defined six-digit code flow. Its Supabase client is deliberately separate from the normal authenticated Session owner, disables persistence and auto-refresh, and exists only for the recovery subflow.
- Any newly discovered shared UI primitive change must declare impact and tests and receive deliberate self-review and required maintainer approval; do not overwrite existing primitives.
- Move every recovery, code, password, success, warning and error string into Simplified Chinese and English i18n resources.

## Acceptance criteria

- [ ] Forgot-password submission always enters the same existence-neutral recovery-code state regardless of whether the email is registered.
- [ ] Supabase Auth recovery email uses a fixed bilingual Simplified Chinese/English template containing a six-digit code and one-hour validity statement, with no reset link, redirect URL or Desktop protocol.
- [ ] Mailpit supplies the real recovery code through bounded polling without exposing the email, code or token in logs, traces or screenshots.
- [ ] Incomplete code submission is disabled; mismatched, expired and already-used codes share the localized invalid-or-expired outcome and remain in the recovery flow.
- [ ] Recovery-code verification occurs through an isolated, non-persisting, non-auto-refreshing Auth client whose Session is never published to the top-level authenticated gate.
- [ ] A verified recovery Session cannot enter the app shell and never reaches the main-process encrypted Session store.
- [ ] The new password applies the same 12–72 original UTF-8 byte contract without trimming or normalization.
- [ ] `same_password` receives its specific localized outcome; 429, network/service failure and unknown provider errors use the approved safe mappings without raw provider text.
- [ ] After a successful password update, the recovery Session requests global refresh-Session revocation, clears all recovery state and returns to login rather than entering the app shell.
- [ ] If global revocation returns an error, the recovery Session still cannot enter or persist as a normal Session, and the UI accurately requires a fresh login without overstating remote revocation.
- [ ] The password-changed security notification is enabled and captured by Mailpit.
- [ ] Playwright proves the complete recovery flow against real disposable Supabase Auth and Mailpit, proves the old refresh Session can no longer refresh, and proves the new password can sign in.
- [ ] Playwright proves that recovery verification and password update never create persisted normal Session ciphertext and that a relaunch before fresh login remains unauthenticated.
- [ ] The final clean-checkout command builds Desktop, starts and cleans disposable Auth/Mailpit, and passes login, signup, verification, Session restore/failure, logout, recovery, localization and Electron security coverage with one CI worker.
- [ ] Installation and test artifacts are scanned and contain no secret/service-role key, database credential, password, email code, access token or refresh token.
- [ ] Lint, node/web typecheck, build, the complete Authentication Playwright suite and resource-contract coverage pass.
- [ ] The completed change contains no Profile, Organization, Membership, business schema, RLS, Go Identity module, custom abuse counter, router, deep link, Magic Link, shared Auth package or unrelated refactor.
- [ ] Native credential-backend support claims are limited to platforms with recorded smoke evidence; missing Windows or Linux Secret Service evidence does not block the Ubuntu merge gate and is not represented as completed support.

