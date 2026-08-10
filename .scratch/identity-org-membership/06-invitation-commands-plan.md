# 06 — Invitation Commands Delivery Plan

Status: implementation plan — 2026-08-10

## Ownership

- **Primary Domain:** Server Identity Module.
- `server/internal/identity/invitations/` owns the four Invitation trusted commands and their transaction/state-machine rules.
- `server/internal/identity/audit/` owns reusable Audit Log snapshot writes; `server/internal/identity/outbox/` owns embedded, write-time rendered email templates.
- `server/internal/identity/routes.go` and `module.go` remain wiring-only composition surfaces.
- `server/internal/identity/integrationtest/` owns the HTTP + real PostgreSQL + Mailpit command seam tests.
- `contracts/openapi.yaml` remains the OpenAPI master; `contracts/identity.yaml` owns the Identity path items it references.
- `supabase/schemas/identity.sql` owns the declarative state for the two Go-only Identity tables. PR review exposed two missing read-path indexes, so this slice adds only those indexes and the generated expand-only migration; it does not change data shape, RLS, grants, or the Supabase-to-Go responsibility seam.

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

## PR Review Remediation

- Before either Create or Resend writes a new Invitation code or Outbox row, it reuses the Identity verification issuance guard: advisory locks are acquired in email-then-IP order, then the shared 60-second cooldown, five-codes-per-email-hour limit, and twenty-codes-per-IP-hour limit count every one-time code action. Rejections roll back the whole Invitation transaction and map to the existing 429 machine codes; only `cooldown_active` carries `Retry-After`.
- Rate-limit accounting is shared across verification and Invitation actions, while invalidation remains action/target scoped: the verification flow supersedes only `action_type IS NULL AND target_id IS NULL` codes and Resend/Revoke supersede only `action_type = 'invitation'` rows for their `target_id`.
- Add a partial composite index on `identity.verification_codes (target_id, created_at DESC)` for non-null action-bound codes and a partial index on `identity.outbox_messages (verification_code_id)` for pending code-carrying rows. These match the locked Accept/Resend/Revoke and pending-Outbox lookup predicates without indexing unrelated rows.
- Generate the expand-only migration from the declarative schema with the repository-pinned Supabase CLI, review it for the two expected `CREATE INDEX` statements only, reset the local stack, and verify representative query plans plus database advisors.

## Test Seams

The pre-agreed seams from the spec are used directly:

1. Mounted `internal/identity` HTTP interface with real PostgreSQL validates command status/error semantics and OpenAPI response conformance.
2. Transactional database rows validate state transitions, unique-index race protection, Audit Log snapshots, and the `verification_code_id` retry horizon.
3. Mailpit validates the emitted single bilingual invitation email and its six-digit code without exposing plaintext through HTTP.

Review regressions additionally cover Create/Resend cooldown, the shared email/IP hourly caps, `Retry-After`, rejected-command atomicity, and action/target-scoped invalidation. Query-plan verification seeds enough rows for the default planner to exercise both indexes under `EXPLAIN ANALYZE`; advisors provide the independent schema check.

Rollback remains code-only: the two expand-only indexes may safely remain if this command code is reverted.
