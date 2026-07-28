# 03 — Persist and Restore the Current-Device Session Securely

**What to build:** A signed-in user can close and reopen Desktop and return to the app shell only after a real Session refresh succeeds. Session material is encrypted by the main process, temporary startup failures are retryable without false logout, terminal failures clear unusable credentials, and current-device logout removes local access even when remote revocation fails.

**Blocked by:** 01 — Establish the Secure Supabase Login Boundary.

**Status:** ready-for-agent

## Implementation constraints

- Keep Session persistence inside the `identity` Domain using domain-local Channel contracts, one Handler per Channel and a main-owned store.
- Reuse the existing generic typed preload bridge. Do not add per-domain preload code or edit a central IPC registry for Authentication.
- Use Supabase's async custom storage seam for the normal authenticated client; do not persist Session material through browser storage or introduce a general-purpose key/value IPC API.
- Every user-visible restore, retry, expiration, unavailable-storage and logout message belongs in Simplified Chinese and English i18n resources.

## Acceptance criteria

- [ ] Domain-local IPC exposes only fixed read, atomic replace and clear operations for the authenticated Session; callers cannot choose arbitrary keys or file paths.
- [ ] Every Session IPC Handler performs runtime payload validation and rejects calls whose sender is not the trusted current renderer.
- [ ] The main-owned store uses Electron `safeStorage` asynchronous encryption/decryption and writes only a versioned ciphertext envelope under application-owned user data.
- [ ] Writes use atomic replacement; truncated ciphertext, random ciphertext, invalid decrypted Session shape and unknown envelope version never fall back to plaintext and are treated as terminal restoration failures.
- [ ] The renderer keeps the active Session only in memory and does not use `localStorage`, IndexedDB, web cache or plaintext JSON persistence.
- [ ] Startup remains in `restoring` until persisted material has crossed a real refresh/validation boundary; a cached access token alone cannot open the app shell.
- [ ] Successful refresh atomically persists the rotated Session before entering the app shell.
- [ ] Invalid, revoked, undecryptable or malformed Session material is cleared, returns to login and shows the localized expired-session outcome without crashing.
- [ ] Offline, timeout and temporary Supabase failure preserve ciphertext, keep the app shell closed, show the localized retryable restore state, and succeed after connectivity returns and the user retries.
- [ ] When secure persistence is unavailable or Linux selects `basic_text`, the current runtime may retain an in-memory Session but nothing is written to disk and the next launch requires login.
- [ ] Current-device logout explicitly requests local scope, then clears memory and ciphertext and returns to login whether the remote response succeeds, reports a missing Session or fails due to network.
- [ ] Remote logout failure uses accurate localized wording that promises only the current Desktop has stopped using the Session; no durable revocation queue or token retention is introduced.
- [ ] Playwright signs in through real Auth, closes and relaunches with the same isolated user data, proves refresh-backed restoration, then logs out and proves a subsequent relaunch remains unauthenticated.
- [ ] Playwright covers offline restart and retry, revoked refresh token, corrupted envelopes, forced `basic_text`, offline logout and a disk scan proving no token, email or complete Session JSON appears in plaintext.
- [ ] Native smoke instructions cover encrypt/relaunch/decrypt/logout/delete for macOS Keychain, Windows DPAPI and controlled Linux Secret Service; support is claimed only for backends with recorded evidence.
- [ ] The existing login/security tracer remains green; lint, node/web typecheck, build, resource contract and the ticket's Electron Playwright tests pass.

