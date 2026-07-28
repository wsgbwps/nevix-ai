# 02 — Deliver Email Signup and Six-Digit Verification

**What to build:** A new user can create an account from the Desktop unauthenticated boundary, receive a six-digit registration code in email, handle resend and safe error states, verify the code, and enter the authenticated app shell without supplying Profile or Organization data.

**Blocked by:** 01 — Establish the Secure Supabase Login Boundary.

**Status:** ready-for-agent

## UI sources and constraints

- Use the shadcn `signup-02` Block as the visual starting point.
- Before applying generated content, run `npx shadcn@latest add signup-02 --dry-run` and `npx shadcn@latest add signup-02 --diff`, review both outputs, then add it without `--overwrite`.
- Adapt the generated layout and form into the existing Authentication Feature. Do not retain generated page/router structure or create a second Auth Feature boundary.
- Use the [Supabase React Password-Based Authentication Block](https://supabase.com/ui/docs/react/password-based-auth) only to cross-check signup API interaction, submission state and safe error-handling cases.
- Do not copy its SPA routing, redirects, link-based email confirmation, Magic Link paths, independent Supabase client or raw provider error messages.
- If the shadcn diff proposes shared UI changes, declare the primitives, blast radius and tests, perform deliberate self-review, and obtain the required maintainer approval before merge. Never use `--overwrite`.
- Move all generated and new user-visible signup, password, code, resend and error copy into Simplified Chinese and English i18n resources.

## Acceptance criteria

- [ ] Registration collects only email and password; it does not request or create Profile, Organization, Membership or business data.
- [ ] Password feedback and submission enforce 12–72 bytes of the original UTF-8 input without trimming, case conversion, normalization or character-composition rules.
- [ ] Registration success and safely normalizable conflicts reach the same existence-neutral state and never branch on the returned User shape or whether an email was actually sent.
- [ ] Supabase Auth registration email is a fixed bilingual Simplified Chinese/English template containing a six-digit code and one-hour validity statement, with no action link or Desktop custom protocol.
- [ ] Mailpit is polled with a bounded deadline to obtain the real registration code; tests do not use fixed sleeps or expose codes in logs and traces.
- [ ] The code form accepts exactly six digits, disables incomplete submission, and maps mismatched, expired and already-used codes to the same localized invalid-or-expired message while preserving the current flow.
- [ ] Resend enforces and displays a 60-second cooldown; a newly issued code succeeds and the previous code no longer verifies.
- [ ] 429 and temporary network/service failures show localized, actionable but existence-neutral outcomes without raw provider text.
- [ ] Successful registration verification gives the normal Session owner the returned Session and enters the authenticated app shell.
- [ ] Login and forgot-password entry points remain available from the post-registration neutral state.
- [ ] Playwright proves a complete new-user signup against real disposable Supabase Auth and Mailpit, including invalid code, resend, old-code rejection and successful verification.
- [ ] Playwright also proves equivalent visible outcomes for already-verified and safely repeatable unverified registration attempts without asserting provider-private response shapes.
- [ ] The existing login tracer remains green; resource-contract coverage includes every new Simplified Chinese and English string.
- [ ] Lint, node/web typecheck, build and the relevant Electron Playwright tests pass with no shared primitive overwrite, router, schema, RLS or Go Identity expansion.

