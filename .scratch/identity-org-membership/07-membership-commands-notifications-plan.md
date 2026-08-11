# 07 — Membership Commands and Notifications: Implementation Plan

## Scope and ownership

- **Primary Domain:** Identity.
- **Membership trusted-command orchestration:** `server/internal/identity/memberships/` owns Leave, ordinary-Member removal, and Admin lifecycle commands, their authorization checks, transaction boundaries, Audit Log writes, and Membership responses.
- **Organization setting command:** `server/internal/identity/organizations/` owns `UpdateOrganizationSettings` and its minimal Organization response.
- **Notification rendering:** `server/internal/identity/outbox/` owns the four rendered bilingual plain-text notification templates and their narrow rendering helper, reusing the existing Outbox worker unchanged.
- **HTTP registration:** `server/internal/identity/` owns route wiring only; handlers stay in the established trusted-command transport pattern.
- **Integration acceptance:** `server/internal/identity/integrationtest/` owns externally observable HTTP/DB/RLS behavior tests.
- **Public contract (shared area):** `contracts/openapi.yaml` owns the additive top-level path references; `contracts/identity.yaml` owns the corresponding Identity Path Items, request/response declarations, and error-code enums. Their impact is limited to the four authenticated Identity commands.

No migration is planned: ticket 05 already provides the Membership, Audit Log, Outbox, RLS, and `identity_app` foundations required by this ticket.

## Additive HTTP contract decision

The spec names commands but deliberately does not prescribe their paths or
request shapes. This plan fixes the following additive, command-oriented
contract before implementation:

- `POST /identity/organizations/{organization_id}/leave` with `{}` ends the
  caller's active Member or Admin Membership.
- `POST /identity/organizations/{organization_id}/members/{membership_id}/remove`
  with `{}` removes an ordinary Member.
- `POST /identity/organizations/{organization_id}/members/{membership_id}/role`
  with `{ "action": "promote" | "demote" | "remove" }` gives the Owner an
  explicit Admin lifecycle operation. `remove` ends an Admin Membership rather
  than inventing a non-role value.
- `PATCH /identity/organizations/{organization_id}/settings` with
  `{ "name": string }` updates the Organization name.

All four responses are `200` with the affected minimal Membership or
Organization representation. Invalid path/body values are `400`; a missing
active organization or target Membership is `404`; an insufficient role is
`403`; an impossible state transition is `409`; and Bearer failures remain
`401`.

## Audit and notification vocabulary

- Audit actions are `membership_left`, `member_removed`, `admin_promoted`,
  `admin_demoted`, `admin_removed`, and `organization_settings_updated`.
- Only `admin_promoted`, `admin_demoted`, `admin_removed`, and
  `member_removed` enqueue email. The three Admin events enqueue exactly one
  codeless Outbox row for the affected User and one for the Owner, including
  when the Owner performed the action. Ordinary Member removal enqueues only
  the removed User. Exit and settings updates enqueue none.
- Each notification is rendered as a bilingual plain-text payload in the
  command transaction. It has no `verification_code_id`, so the existing
  Outbox Worker delivers it without special behavior.

## Security and behavior plan

1. Add a focused failing integration test for each command through its Bearer-JWT HTTP seam, beginning with leave and removal/role-setting authorization cases.
2. Implement the minimum transactional command behavior under `identity_app`: lock the relevant active Membership rows, enforce Owner/Admin rules and non-enumerating 404/403 outcomes, mutate the intended row, then snapshot the Audit Log in the same transaction.
3. Render and enqueue only the four specified notification events in that same transaction. Each recipient gets one bilingual plain-text Outbox row; leave, join, and organization-name changes enqueue none.
4. Add contract-conformance assertions and RLS verification that a removed user immediately loses active Organization visibility.

## Acceptance boundary

- Member/Admin leaving preserves an ended Membership; Owner cannot leave.
- Owner/Admin removal and Owner-only role changes preserve the single active Owner invariant and use 404/403 semantics prescribed by the contract.
- Organization settings update is limited to Owner/Admin.
- Audit rows snapshot actor/target at write time; notification rows exactly match the four-event recipient matrix.
- The final changed paths pass the relevant integration and contract checks, full Go test suite, independent code review, and final-state evidence binding before commit.
