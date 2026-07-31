# 08 — Session store hardening follow-ups

**What to build:** Two low-severity hardening items in the authentication session persistence path, kept together because both are small, behaviour-preserving, and touch only the authentication Domain.

**Blocked by:** None.

**Status:** needs-triage

## Items

1. **Do not delete the previous good envelope on a failed replace.** `replacePersistedSession` in `apps/desktop/src/main/authentication/session-store.ts` removes both the pending file and the existing Session file when a write fails. The `rename` is atomic, so a failed pending write never corrupts the existing envelope; deleting it forces an unnecessary re-login on the next launch. Keep the fail-closed guarantee (never plaintext) while preserving the last successfully written ciphertext.
2. **Bound the transient key map in the renderer storage adapter.** `transientValues` in `apps/desktop/src/renderer/src/features/authentication/session/persisted-session.ts` grows without limit for non-Session keys written by supabase-js (PKCE verifiers and similar). Cap or expire entries so a long-lived renderer cannot accumulate them indefinitely.

## Acceptance sketch

- A simulated write failure (e.g. read-only pending path) leaves the prior envelope intact and the next launch restores the Session.
- The adapter never stores more than a small fixed number of transient keys.

## Comments

- Raised by the PR #5 security review (low severity). Also noted there, no change requested: `canPersistSecurely()` mutates safeStorage state inside a predicate on the test-only Linux path — a clarifying comment is welcome if either item touches that function.
