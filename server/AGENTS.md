# Server agent routing

- Default business capability changes to the smallest valid simple Module
  under `internal/<module>/`; introduce responsibility subpackages or the four
  DDD layers only when demonstrated complexity warrants them under
  [ADR-0003](../docs/adr/0003-complexity-driven-ddd-layering.md).
- For ordinary Go changes run `(cd server && go vet ./... && go test ./...)`.
  Run `make test-identity-integration` or `make test-creation-integration` from
  the repository root when the affected seam requires its real dependencies.
- Implementation agents need not read
  [`../CODING_STANDARDS.md`](../CODING_STANDARDS.md); Server reviewers must
  apply it after the relevant checks pass.
