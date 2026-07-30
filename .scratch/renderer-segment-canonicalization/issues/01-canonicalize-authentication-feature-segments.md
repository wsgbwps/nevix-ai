# 01 — Canonicalize Authentication Feature segments

**What to build:** The Authentication Feature's renderer code lives entirely in canonical segment vocabulary, so a maintainer navigating the Feature finds its screen under `ui` and its state machine under `model` instead of the legacy `components` and `hooks` names, and Desktop architecture verification passes with an empty migration-debt allowlist. No user-visible Authentication behavior changes.

**Blocked by:** None — can start immediately. (The Desktop Domain-first architecture migration, `.scratch/desktop-domain-first-architecture/issues/02`, is already resolved.)

**Status:** done

- [x] The Authentication Feature's legacy `components` and `hooks` segments no longer exist; their responsibilities live in canonical `ui` and `model` segments.
- [x] The Feature's public-interface contract is unchanged: external callers keep importing through the Feature's root public index, which still contains only explicit named re-exports.
- [x] Both `renderer/segment-vocabulary` migration-debt allowlist entries are deleted, per their recorded removal trigger, and the allowlist only shrinks.
- [x] The Desktop architecture verification command passes against the canonical workspace with no new allowlist entries or lint suppressions.
- [x] Existing Authentication Electron Playwright assertions pass unchanged; Node and web typechecks and the Desktop production build pass.
- [x] The final diff touches only the Authentication Feature and the migration-debt allowlist — no opportunistic renames in other Features, shared areas, or Main.
