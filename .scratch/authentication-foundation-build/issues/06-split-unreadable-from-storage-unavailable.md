# 06 — Split the unreadable Session outcome from secure-storage unavailability

**What to build:** `readPersistedSession` in `apps/desktop/src/main/authentication/session-store.ts` returns `unreadable` both when the envelope is genuinely corrupt and when `canPersistSecurely()` is temporarily false (e.g. a locked Linux keyring or a briefly unavailable Keychain). The renderer's restore flow deletes the Session file on `unreadable`, so a transient secure-storage outage permanently destroys recoverable ciphertext and forces a re-login.

**Blocked by:** None, but requires an approved written plan before implementation — this adds a new outcome to `PersistedSessionRead` in `apps/desktop/src/shared/ipc/authentication/types.ts`, which is a public IPC contract change.

**Status:** needs-triage

## Proposed direction

- Add a distinct outcome (e.g. `locked` or `storage-unavailable`) for "the ciphertext may be fine, but decryption is not possible right now".
- The renderer keeps the file on that outcome and shows the retryable restore-failure boundary instead of clearing local credentials.
- `unreadable` remains terminal: malformed envelope, wrong version, or a decrypt that fails while the backend reports itself available.

## Acceptance sketch

- Corrupt-envelope E2E cases keep their current terminal behaviour (file deleted, session-expired notice).
- A launch with `NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE=1` and a valid on-disk envelope no longer deletes the file, and a subsequent launch without the flag restores the Session.

## Comments

- Raised by the PR #5 security review (medium severity): `unreadable` conflates corruption with transient unavailability, making a destructive clear reachable from a recoverable state.
