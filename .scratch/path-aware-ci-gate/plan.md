# Path-aware PR CI gate

Primary Domain: repository delivery governance.

Owner boundaries:

- `.github/workflows/` owns pull-request orchestration and the specialized CI workflows.
- `docs/adr/0007-e2e-test-tiering.md` owns the Smoke Suite and Full E2E Suite trigger decision.
- `.scratch/path-aware-ci-gate/` owns this delivery-change plan.
- GitHub repository rules own any future server-side required-check configuration.

## Decision

1. A pull request targeting `main` runs one always-triggered `CI gate` workflow.
2. Its change-classification job mirrors the four specialized workflows' existing
   `push.paths` inputs. Documentation, `.scratch/`, `AGENTS.md`, and
   non-runtime `.codex/` changes run only the fast diff validation and final gate.
3. Desktop, Server, Mail Smoke, and Desktop E2E workflows keep their current
   `push.paths` behavior and expose `workflow_call` for the gate. The gate
   conditionally calls only the relevant workflows and fails when a selected
   workflow does not succeed.
4. A change to the gate itself selects every specialized workflow, because it
   changes their routing policy.
5. Full E2E remains on relevant `main` pushes and manual dispatch. No schedule
   is added.
6. If GitHub branch protection becomes available, require only the final
   `CI gate` check rather than path-filtered specialized checks.

## Acceptance

- A documentation-only PR completes only the fast validation and `CI gate`.
- Each specialized path set selects the same workload as its existing
  `push.paths` filter.
- A selected reusable workflow failure makes `CI gate` fail.
- A relevant `main` push still invokes its existing specialized workflow;
  Full E2E remains post-merge/manual only.
