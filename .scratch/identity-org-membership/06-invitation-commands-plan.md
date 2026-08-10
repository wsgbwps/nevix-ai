# 06 — Invitation Commands Delivery Plan

Status: implementation plan — 2026-08-10

## Ownership

- **Primary Domain:** Server Identity Module.
- `server/internal/identity/invitations/` owns the four Invitation trusted commands and their transaction/state-machine rules.
- `server/internal/identity/audit/` owns reusable Audit Log snapshot writes; `server/internal/identity/outbox/` owns embedded, write-time rendered email templates.
- `server/internal/identity/routes.go` and `module.go` remain wiring-only composition surfaces.
- `server/internal/identity/integrationtest/` owns the HTTP + real PostgreSQL + Mailpit command seam tests.
- `contracts/openapi.yaml` remains the OpenAPI master; `contracts/identity.yaml` owns the Identity path items it references. No migration changes: ticket 05 already supplies the required schema, RLS, grants, and retry-horizon foreign key.

## Public Contract

All operations require Bearer JWT and use the existing `{error, message}` envelope:

| Command          | Route                                                                               | Request   | Success                        |
| ---------------- | ----------------------------------------------------------------------------------- | --------- | ------------------------------ |
| CreateInvitation | `POST /identity/organizations/{organization_id}/invitations`                        | `{email}` | 202 + minimal invitation       |
| ResendInvitation | `POST /identity/organizations/{organization_id}/invitations/{invitation_id}/resend` | `{}`      | 202 + refreshed invitation     |
| RevokeInvitation | `POST /identity/organizations/{organization_id}/invitations/{invitation_id}/revoke` | `{}`      | 200 + revoked invitation       |
| AcceptInvitation | `POST /identity/invitations/{invitation_id}/accept`                                 | `{code}`  | 200 + active Member membership |

A caller with no active Membership in the Organization receives 404 `organization_not_found`; an active Member lacking Owner/Admin authority receives 403 `insufficient_organization_role`. A forwarded invitation is invisible to a nonmatching session (`invitation_not_found`). Invalid UUIDs, email, and code shapes return 400. Conflict/state errors are explicit snake_case codes, including active-member and pending-invitation conflicts, revoked/expired invitations, and exhausted code attempts.

## Transaction Invariants

- Every command runs as `identity_app`, locks the actor Membership and/or target Invitation with `SELECT … FOR UPDATE`, and relies on existing partial unique indexes as the concurrency backstop.
- Create rejects an active Member's normalized email and permits a previously ended Membership. After its authorization and subject locks, it writes the Invitation with a seven-day deadline from `clock_timestamp()`, an `action_type='invitation'` verification code bound by `target_id`, Audit Log snapshot, and rendered Outbox row atomically.
- Resend keeps the Invitation row, resets both validity deadlines to seven days from `clock_timestamp()` after its locks, cancels unsent old-code mail, supersedes the old code, refuses every code hash previously issued for that Invitation, writes the new code/email, and records one audit action.
- Revoke transitions only a pending Invitation; repeat revocation is a no-op with no duplicate audit row. It cancels unsent code mail and supersedes its active code.
- Accept verifies the caller's directory email before exposing state. It evaluates both expiry deadlines against the database clock; a wrong code atomically increments `failed_attempts`; the fifth failed attempt cancels any unsent mail and makes the code permanently unusable. A valid acceptance follows the required order: validate code → insert Member Membership → mark Invitation accepted → write Audit Log → mark code consumed.
- Audit actor/target names are loaded from `profiles` in the command transaction, falling back to the verified directory email only when Profile setup is incomplete, and stored as immutable snapshots. The bilingual invitation email is rendered through an embedded Go text template before its Outbox row is inserted; the Worker remains a pure deliverer.

## Test Seams

The pre-agreed seams from the spec are used directly:

1. Mounted `internal/identity` HTTP interface with real PostgreSQL validates command status/error semantics and OpenAPI response conformance.
2. Transactional database rows validate state transitions, unique-index race protection, Audit Log snapshots, and the `verification_code_id` retry horizon.
3. Mailpit validates the emitted single bilingual invitation email and its six-digit code without exposing plaintext through HTTP.

Rollback is code-only: ticket 05's expand-only schema remains valid if this command code is reverted.
