# Coding standards for review

This is a reviewer-only checklist for judgement that deterministic checks
cannot replace. Implementation agents need not load it; every code reviewer
must. Run the repository's mechanical checks separately and do not restate
their path, import, Channel, or syntax rules here.

## Repository judgement

- **Cohesive scope:** Every changed line belongs to one requested vertical
  slice and primary owner. Remove only artifacts made unused by that slice;
  flag opportunistic cleanup, generalized refactors, and bundled migrations.
- **Ownership and interface depth:** Place responsibility with the canonical
  owner named by `README.md`, the relevant `CONTEXT.md`, and ADRs. Prefer a
  narrow, stable interface over exposing internal structure. New top-level or
  shared owners, synonymous wrappers, and responsibility changes need an
  architecture decision rather than an improvised seam.
- **Abstraction and deletion test:** Prefer existing code, platform features,
  and direct implementation. An abstraction or custom responsibility boundary
  earns its place only when deleting it would split stable invariants,
  lifecycle, knowledge, or multiple real consumers; symmetry and predicted
  growth are insufficient.
- **Comments:** Keep reasons and contracts at their narrowest authoritative
  location, especially for security, authorization, transactions,
  concurrency, ordering, and compatibility. Flag narration, duplicated ADR
  history, or TODOs without an issue or concrete removal condition.
- **Migration and compatibility:** Compatibility code requires a current
  external contract. Prefer one coherent cutover over parallel old/new paths,
  and keep legacy cleanup limited to the responsibility already changing.
  Record migration history and future work in an ADR or issue.
- **Shared areas:** A move into a shared owner must serve real consumers with
  the same semantics. The PR must identify affected consumers, contract
  impact, and focused verification.
- **Test ownership:** Place a test at the boundary it observes, not according
  to its fixture or infrastructure. Public-contract behavior belongs at the
  public seam; internal algorithms, SQL, transactions, and failure modes stay
  with their owning package. Test support is not a production interface.

## Desktop judgement

- A Desktop Domain or Feature must represent one cohesive business owner
  across only the runtimes it actually needs. App-level aggregation and
  platform lifecycle stay explicit owners rather than artificial Domains.
- Keep public Feature and Main interfaces smaller than their implementations;
  composition belongs at the app or process root. A custom Feature segment
  must improve locality for a stable responsibility instead of naming a code
  form or mirroring another Feature.
- Promote renderer code to a shared owner only after genuinely equivalent
  cross-Feature use appears. Migrate legacy segment names when their
  responsibility changes, not for visual uniformity.
- Review new cross-process and native seams against the trusted-data-plane
  ADRs for least privilege, ensuring file paths, credentials, and signed
  capabilities remain with their authoritative process.

## Server judgement

- Keep a Module simple until aggregates, use-case orchestration, or multiple
  adapters justify deeper DDD layers. Split responsibility-named subpackages
  only when distinct invariants or lifecycle clusters have emerged.
- Keep the Module's public contract deep and the server entrypoint limited to
  wiring. Cross-Module behavior needs one clear owner; shared infrastructure
  requires multiple real consumers with the same protocol and lifecycle.
- Judge Server tests by the observed seam: Module contract tests exercise only
  the Module surface, while package-internal SQL, query plans, transactions,
  and catalogs stay package-local even when they use a real database.
