# Written plan — Issue 06: split `storage-unavailable` out of `unreadable`

**Status:** proposed
**Issue:** `06-split-unreadable-from-storage-unavailable.md` (ready-for-agent)
**Risk class:** high — public IPC contract change (`PersistedSessionRead`) in the authentication domain. Lands via branch + PR per `AGENTS.md`.

## Problem

`readPersistedSession` collapses two unrelated failure modes into `unreadable`: a genuinely corrupt envelope (terminal) and `canPersistSecurely()` being false at read time (recoverable). The renderer deletes the session file on `unreadable`, so a transient secure-storage outage permanently destroys valid ciphertext and forces a re-login.

## Decision 1 — outcome name: `storage-unavailable`

Chosen over `locked`:

- `canPersistSecurely()` returns false for more causes than a locked keyring: `safeStorage.isEncryptionAvailable()` being false, the rejected Linux `basic_text` backend, and the E2E unavailability flag. `locked` over-promises a single cause the main process cannot actually distinguish.
- The write path already uses `unavailable` in `PersistedSessionWrite`. `storage-unavailable` keeps one vocabulary root across the read and write halves of the same contract instead of introducing a second term for the same condition.

New contract in `apps/desktop/src/shared/ipc/authentication/types.ts`:

```ts
export type PersistedSessionRead =
  | { readonly outcome: 'session'; readonly session: string }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'storage-unavailable' }
  | { readonly outcome: 'unreadable' }
```

Semantics: *the on-disk ciphertext may be intact, but decryption is not possible right now.* No payload — the renderer needs no further detail to choose the retryable boundary.

## Decision 2 — evaluation order when unavailability and corruption coincide

**Structural envelope validation runs first; `storage-unavailable` is returned only for a structurally valid envelope.** All structural checks are backend-independent, so they stay decisive even while storage is down:

| Step (in order) | Condition | Outcome |
| --- | --- | --- |
| 1. Read file | ENOENT | `empty` |
| | other I/O error | `unreadable` (unchanged) |
| 2. Envelope length | over `MAXIMUM_ENVELOPE_LENGTH` | `unreadable` |
| 3. Parse envelope | bad JSON / wrong version / invalid base64 | `unreadable` |
| 4. `canPersistSecurely()` | false | **`storage-unavailable`** (new) |
| 5. Decrypt | throws while backend available | `unreadable` |
| 6. Session shape | invalid | `unreadable` |
| 7. | valid | `session` |

Rationale: a corrupt envelope has no recoverable value, so reporting it terminally even during an outage keeps cleanup deterministic and preserves every existing corrupt-envelope test verbatim. The only behavioural delta versus today is step 4 splitting out of the current combined `!ciphertext || !canPersistSecurely()` guard. Steps 5–6 cannot be reached while storage is unavailable, so their `unreadable` semantics ("failed while the backend reports itself available") hold by construction.

## Renderer change

In `restore()` (`use-authentication.ts`):

- `clearPersistedSession()` keys off `outcome === 'unreadable'` only.
- `outcome === 'storage-unavailable'` sets `status: 'restore-failure'` and returns — no file deletion, no `session-expired` notice, no Supabase client work. The existing retry button re-runs `restore()`, which re-reads the store; once the backend recovers, the untouched envelope restores normally.

Accepted trade-off: if the backend never recovers (e.g. permanent downgrade to `basic_text` after an envelope was written), the user stays on the retry boundary. This matches the boundary's existing behaviour for persistent network failure; an escape hatch is a separate concern and out of scope.

No localization changes: the `restoreFailure` boundary strings already exist.

## Test plan

- **Unchanged:** `session-persistence.spec.ts` — 'corrupt, unknown, random, and malformed encrypted Session envelopes are terminal and deleted' passes as-is (Decision 2 guarantees this). 'unavailable secure storage keeps only the runtime Session…' passes as-is (no envelope ever exists in that scenario, so reads yield `empty`).
- **New E2E** in `session-persistence.spec.ts`: sign in without the flag to produce a valid envelope; relaunch with `NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE=1` and assert the restore-failure boundary is shown and the envelope file still exists; relaunch without the flag and assert the Session restores.
- **New E2E case (coincidence path):** corrupt envelope + `NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE=1` → terminal behaviour (file deleted, session-expired) — pins Decision 2.
- **Exhaustiveness:** typecheck across preload allowlist, IPC handler, and renderer confirms every `PersistedSessionRead` consumer handles the new member.

## Delivery

1. Branch `fix/session-read-storage-unavailable`; single PR referencing issue 06 and this plan.
2. Commits: contract + session-store split; renderer routing; E2E coverage.
3. Verification before merge: `pnpm typecheck`, unit tests, auth E2E suite, `verify-desktop-architecture`.
4. Rollback: revert the PR — no data migration; envelopes on disk are readable by both revisions.
