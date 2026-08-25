# Comment governance and high-confidence cleanup

## Goal

Establish one repository-wide comment policy and remove only comments that
repeat code, preserve obsolete history, or describe future work. Runtime
behavior, public interfaces, security boundaries, and architecture remain
unchanged.

## Owning boundaries

- Repository instructions: root `AGENTS.md`.
- Server: Identity Module package and integration-test comments.
- Desktop: app-owned Shell/Settings comments, Authentication comments, and one
  Connection E2E fixture comment.

No files are added or moved inside product source boundaries.

## Safety constraints

- Preserve comments that explain authorization, transaction, concurrency,
  database privilege, TLS/TOFU, CSP, persistence, or injection constraints.
- Keep Go documentation comments for exported identifiers focused on their
  public contract.
- Make comment-only diffs; do not rename symbols, restructure tests, or change
  executable code.

## Verification

- Inspect the final diff to prove every product-source change is comment-only.
- Run Go test/vet and Desktop lint/typecheck.
- Confirm the diff contains only the declared owners and repository instruction
  file.
