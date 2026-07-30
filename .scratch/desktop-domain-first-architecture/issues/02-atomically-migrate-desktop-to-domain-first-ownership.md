# 02 — Atomically migrate Desktop to Domain-first ownership

**What to build:** Move Authentication and Language behavior to their canonical Desktop Domain ownership in one green migration. Consolidate Language Mode and Interface Language, switch all Language Channels and callers to the canonical Domain name, adopt Domain-first IPC registration discovery, and remove the superseded topology without changing any user-visible Authentication, Session, Language Mode, or Interface Language behavior.

**Blocked by:** 01 — Establish the executable Desktop architecture contract.

**Status:** ready-for-agent

- [ ] Authentication Session implementation and its IPC adapter share the Authentication Domain owner, with one directly nested Handler per existing Authentication Channel and no change to Channel request/response semantics.
- [ ] Language Mode persistence, Interface Language initialization/resources, Main public operations, and domain-local IPC adapter are consolidated under one Language Domain owner.
- [ ] The renderer’s Language Mode interface and localization resources use the canonical Language Feature owner and continue to be composed through its public interface.
- [ ] The Language cross-process interface atomically exposes `language:get-bootstrap`, `language:get-language-mode`, `language:set-language-mode`, and `language:language-mode-changed`.
- [ ] Authentication continues to expose `authentication:read-session`, `authentication:replace-session`, and `authentication:clear-session` with unchanged behavior.
- [ ] Shared IPC declaration merging and named request/response types remain distributed by canonical Domain without a central registry or augmentation barrel.
- [ ] Preload remains the unchanged generic typed invoke/on seam and contains no per-Domain implementation.
- [ ] The composition root initializes Language through its public interface, discovers registrations through the single canonical Domain-first pattern, registers them before window creation, and contains no Domain logic.
- [ ] Registration modules remain side-effect-free on load, synchronous, order-independent, and separate from Domain initialization.
- [ ] Superseded Adapter-first ownership, competing `settings`/`i18n` Domain names, nested Handler directories, legacy registration discovery, and obsolete Language Channel prefixes are removed.
- [ ] No compatibility Channel alias, second discovery pattern, central registry, old-path re-export, or long-lived migration shim is introduced.
- [ ] Platform responsibilities such as window, updater, and tray remain explicit non-Domain owners, and no empty mirror directories or speculative public interfaces are created.
- [ ] Existing legacy Authentication segment names outside the migration’s changed responsibility are not mechanically renamed or generalized into new conventions.
- [ ] Architecture-verifier allowlist entries removed by the migration are deleted; any unrelated approved legacy entries remain exact, justified, and no broader than before.
- [ ] Existing Language Playwright assertions pass unchanged for offline access, startup resolution, immediate switching, persistence, native-window updates, resource completeness, and fallback behavior.
- [ ] Existing Authentication Playwright assertions pass unchanged for the login boundary, verification and recovery flows, secure Session persistence, startup recovery, retryable and terminal failures, Electron security, and current-device logout.
- [ ] Node and web typechecks, Desktop production build, lint, architecture verification, and verifier contract tests all pass.
- [ ] The migration is independently buildable and revertible as one change, and the final diff contains only the declared Authentication Domain, Language Domain, cross-process interface, renderer composition, composition-root wiring, tests, and verification-supporting boundaries.
- [ ] Existing uncommitted architecture documentation is preserved and not reverted, overwritten, or expanded into unrelated architectural changes.
