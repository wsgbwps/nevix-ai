# Agent routing

## Context and architecture

- Before work under `apps/desktop/` or `server/`, read that area's `AGENTS.md`.
- Before development, read and follow the `/ponytail` skill at `full` intensity.
- Start architecture and domain work with [`CONTEXT-MAP.md`](CONTEXT-MAP.md),
  the relevant `CONTEXT.md`, [`README.md`](README.md) ownership boundaries, and
  referenced ADRs.
- Before changing the Go trusted data plane, auth, storage, push, trusted
  operations, or AI providers, read [ADR-0013](docs/adr/0013-onprem-single-tenant-delivery.md),
  [ADR-0014](docs/adr/0014-go-sole-trusted-data-plane.md), and
  [ADR-0015](docs/adr/0015-single-tenant-user-system-and-go-authorization.md);
  AI Creation seams also require
  [ADR-0016](docs/adr/0016-ai-creation-v1-trusted-seams.md).
- A responsibility seam or accepted architecture change requires an ADR before
  implementation.

## Delivery and review

- Before committing, pushing, opening or merging a PR, deploying, or taking a
  high-risk external/system action, read
  [`docs/agents/delivery.md`](docs/agents/delivery.md). Its authority and risk
  gates apply; explicit user instructions override defaults.
- High-risk work defined there requires a brief `.scratch/` plan before
  implementation.
- Implementation agents need not read
  [`CODING_STANDARDS.md`](CODING_STANDARDS.md); every reviewer must use it
  after deterministic checks pass.

## Delegation and repository operations

- Delegate independent workstreams in parallel to the narrowest worker, with
  one writer per file or scope; use read-only explorers for broad surveys and
  a reviewer for completed diffs. Keep coupled sequential work local.
- GitHub Issues are canonical: use `docs/agents/issue-tracker.md`; use
  `docs/agents/triage-labels.md` for labels and `docs/agents/domain.md` for
  domain-document workflows.
