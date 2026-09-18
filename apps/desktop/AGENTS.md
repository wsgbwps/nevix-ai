# Desktop agent routing

- For IPC/Main/Preload ownership or routing changes, read root
  [ADR-0001](../../docs/adr/0001-ipc-self-registration.md) and Desktop
  [ADR-0003](docs/adr/0003-main-domain-first-ipc-adapters.md). For renderer
  ownership or routing, read root
  [ADR-0002](../../docs/adr/0002-feature-sliced-vertical-slice.md) and Desktop
  [ADR-0004](docs/adr/0004-renderer-routing-topology.md).
  Language/localization changes also require Desktop
  [ADR-0001](docs/adr/0001-feature-owned-localization-resources.md)/[ADR-0002](docs/adr/0002-main-process-owns-language-mode.md);
  Creation lifecycle or parameter changes require Desktop
  [ADR-0005](docs/adr/0005-creation-operation-and-task-refresh-lifetimes.md)/[ADR-0006](docs/adr/0006-generation-parameter-field-inventory.md)
  and the relevant root AI Creation ADR.
- For Desktop authentication/authorization, server TLS/connectivity, credential
  handling, or another cross-process security-boundary change, read the relevant
  root [ADR-0013](../../docs/adr/0013-onprem-single-tenant-delivery.md),
  [ADR-0014](../../docs/adr/0014-go-sole-trusted-data-plane.md), or
  [ADR-0015](../../docs/adr/0015-single-tenant-user-system-and-go-authorization.md).
  AI Creation native-file or upload changes also require
  [ADR-0016](../../docs/adr/0016-ai-creation-v1-trusted-seams.md).
- `pnpm --filter @nevix/desktop verify:architecture` is the source of truth for
  deterministic path, import, public-interface, registration, Channel, and
  Preload rules. Run it after relevant changes; do not duplicate its rules here.
- Implementation agents need not read
  [`../../CODING_STANDARDS.md`](../../CODING_STANDARDS.md); Desktop reviewers
  must apply it after the architecture verifier passes.
