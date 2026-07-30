# 01 — Establish the executable Desktop architecture contract

**What to build:** Provide one Desktop-local verification command that maintainers and CI can run to detect deterministic violations of the accepted Domain-first architecture before source migration begins. The command must validate Main ownership and registration, cross-process Channel consistency, generic preload behavior, and renderer Feature interfaces while allowing only the repository’s explicitly documented pre-migration debt.

**Blocked by:** None — can start immediately.

**Status:** ready-for-human — implemented; awaiting maintainer review (7 allowlist entries exceed the literal AGENTS.md debt enumeration)

- [x] One documented Desktop command runs the architecture verifier and its focused contract tests locally, returns a non-zero status on violations, and is invoked by Desktop CI.
- [x] The verifier checks Domain-first Main adapter placement, directly nested Channel Handlers, the absence of extra Handler wrapper layers, Domain implementation independence from IPC, cross-Domain public-interface usage, and acyclic Main Domain dependencies.
- [x] The verifier checks the canonical registration discovery form and requires registration modules to expose only a synchronous, order-independent `register(): void` interface without load-time initialization, network, migration, or storage side effects.
- [x] The verifier checks that canonical Domain names agree across shared IPC declarations, Main adapters, renderer Features, and `<domain>:<action>` Channel prefixes.
- [x] The verifier rejects per-Domain preload imports, wrappers, Channel constants, or registries while accepting the existing generic typed invoke/on bridge.
- [x] The verifier checks renderer Feature root-source limits, explicit named public exports, outside deep imports, internal self-imports, peer Feature imports, and canonical segment vocabulary.
- [x] The current approved migration debt is represented only by exact-path allowlist entries, each with a reason and a verifiable removal trigger; stable seams and canonical vocabulary cannot be bypassed with a general disable.
- [x] Minimal fixtures prove a canonical tree passes and representative violations fail with stable, actionable diagnostics that identify the rule, location, and expected shape.
- [x] Fixture coverage includes Domain and non-Domain Main owners together so platform responsibilities are not incorrectly treated as business Domains.
- [x] The implementation remains a surgical Desktop-local verification module and does not introduce a repository-wide plugin framework, shared architecture layer, Server checks, or automated judgments about responsibility, interface depth, or deletion tests.
- [x] Desktop lint and the new verification command pass with the current documented migration-debt allowlist.
- [x] Changed paths are reviewed against the Desktop ownership contract, and any CI or composition-root supporting change is called out with its impact and verification evidence.
