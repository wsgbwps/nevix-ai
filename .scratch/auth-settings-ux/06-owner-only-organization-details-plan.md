# 06 — Owner-only Organization Details: Implementation Plan

## Boundary and fixed point

- **Acceptance boundary:** every active Member can see the authoritative Organization name in the current Settings presentation; only Owner receives rename controls and can successfully call `UpdateOrganizationSettings`. Active Admin and Member calls return the existing `insufficient_organization_role` 403, while Former Member and outsider calls retain non-enumerating 404 behavior. Owner updates still trim a nonblank name, atomically write `organization_settings_updated`, enqueue no Outbox row, and conform to the unchanged request/response/error envelope.
- **Fixed point:** `21b3873` (`origin/main` when this branch was created).
- **Primary Domain:** Organization.
- **Atomic rollback boundary:** Desktop affordance, Server trusted-command authorization, and the public identity contract land and revert together in this PR. No schema, migration, RLS, GRANT, route, version, request, response-envelope, Realtime, polling, or Settings coordinator change is planned.

## Ownership and task-owned paths

- **Organization Feature presentation:** `apps/desktop/src/renderer/src/features/organization/ui/organization-name-settings.tsx` owns the role-sensitive Organization name presentation; `members-settings.tsx` keeps the existing ticket-06 mounting point without implementing ticket 08's independent Settings Section.
- **Desktop acceptance:** `apps/desktop/tests/organization/members-management.spec.ts` owns the existing Electron Playwright Owner/Admin/Member scenarios.
- **Trusted command:** `server/internal/identity/organizations/settings.go` owns Owner-only authorization and the existing atomic name/Audit transaction; `server/internal/identity/organizations/create.go` owns the package's existing HTTP error mapping.
- **Server and contract acceptance:** `server/internal/identity/integrationtest/membership_commands_test.go` owns real-database HTTP authorization, state, Outbox, and response-conformance evidence.
- **Public contract shared area:** `contracts/identity.yaml` owns the command's authorization description and response example. Its path, request schema, 200 schema, and error envelope remain unchanged.
- **Delivery record:** this plan and `.scratch/auth-settings-ux/issues/06-owner-only-organization-details.md` own the local tracker state and final PR handoff.

No source file is added or moved. Every changed source remains inside the narrowest existing owner above.

## Test-first slices

1. **Server HTTP/OpenAPI seam:** change the real-database integration case so Admin and Member receive 403, Former Member and outsider receive 404, missing/blank names remain 400, and only Owner produces the trimmed Organization update, one Audit row, and no Outbox row. Run the focused integration test and observe the existing Admin-200 implementation fail before tightening authorization.
2. **Electron Playwright seam:** extend the existing Owner/Admin/Member scenarios so all three see the Organization name, only Owner sees a textbox/save controls, and Owner rename still updates the authoritative UI projection. Run the focused smoke scenario and observe the existing hidden-Member/Admin-editor presentation fail before changing the Feature.
3. Update only the minimum Server condition, Organization Feature rendering, and contract authorization text/example needed to pass those seams.

## Verification and review

- Run focused red/green checks while implementing, then Desktop lint/typecheck/build and Go tests.
- Before initial review, run the relevant full Identity integration and Desktop smoke E2E suites, including response-level OpenAPI conformance and packaged localization coverage where applicable.
- Freeze the exact task-owned diff from `21b3873`, run the single Standards/Spec review required by `/implement`, disposition every finding, and use only the bounded accepted-blocker repair loop if necessary.
- After the final code edit, bind the current diff, final relevant check, closed finding ledger, and review conclusion through `docs/specs/final-state-evidence.md` before commit, push, and PR creation.
