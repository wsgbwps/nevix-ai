# Authentication Session persistence hardening — plan conformance

## Delivery boundary

- **Acceptance boundary:** harden the persisted Authentication Session path: the renderer persistence
  adapter invokes the Main Session channel only for access-token-bearing Session values, so transient
  PKCE values can never overwrite the stored Session; a stored legacy Supabase Session object is
  migrated to the strict Authentication-owned schema (`expires_in` and `user.email` required) on
  first successful decrypt; an unavailable secure-storage backend preserves the existing encrypted
  envelope (outcomes `storage-unavailable` / `unavailable`) while only structural corruption
  discards the persisted file; clear removes both the envelope and its pending write in parallel.
  Remembered-device-data deletion UI is excluded.
- **Fixed point:** `deb8a33a0eda42bae067063aeffcf62e2d7dddf0` (`origin/main` at branch creation).
- **Primary Domain:** Desktop Authentication Domain.
- **Narrowest owners:** `apps/desktop/src/main/authentication/session-store.ts` owns the encrypted
  envelope store; `apps/desktop/src/renderer/src/features/authentication/session/persisted-session.ts`
  owns the supabase-js `SupportedStorage` adapter.

## Task-owned paths

- `apps/desktop/src/main/authentication/session-store.ts`
- `apps/desktop/src/renderer/src/features/authentication/session/persisted-session.ts`
- `apps/desktop/tests/auth/session-persistence.spec.ts`
- `apps/desktop/tests/unit/persisted-session-transient-keys.test.mts`
- This plan.

Every exact changed path is tracked and frozen before the one initial code review. No Server, public
contract, schema, migration, RLS/GRANT policy, shared renderer layer, dependency, or route change is
allowed.

## Pre-agreed seams and vertical checks

1. **Transient-value seam:** unit test asserts the Session slot keeps non-Session values in memory
   without invoking Main, and invokes `authentication:replace-session` exactly for values with a
   non-empty `access_token`.
2. **Legacy-schema seam:** E2E signs in and asserts the stored envelope decrypts to exactly the
   canonical key set (`access_token`, `expires_at`, `expires_in`, `refresh_token`, `token_type`,
   `user` with `email` and `id`).
3. **Outage seam:** E2E forces `NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE` mid-session and asserts the
   write reports `unavailable` and the existing envelope is byte-identical; the existing outage
   restore test proves the envelope survives relaunch and restores after recovery.
4. **Corrupt-envelope seam:** existing E2E proves a structurally corrupt envelope is terminal,
   deleted, and stays deleted even while secure storage is unavailable.
5. **Read-failure seam:** E2E makes the envelope temporarily unreadable (POSIX mode `000`) and
   asserts the read reports `storage-unavailable` with the envelope preserved, then restores.

Each slice follows red → green with minimum code. After the last product edit, the current diff is
checked through final-state evidence, reviewed once into the shared finding ledger, and only
accepted blockers enter the bounded targeted repair loop.

## Rollback

The change is a single linear commit on a short-lived task branch. Rollback reverts the commit;
the envelope format is backward-compatible (legacy sessions are rewritten only after a successful
decrypt), and an older build re-reads the canonical schema as a valid Session shape. No data
migration outside the Desktop Authentication Domain runs, and no server-side state changes.
