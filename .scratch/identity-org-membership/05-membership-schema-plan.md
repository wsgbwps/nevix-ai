# 05 — Membership schema implementation plan

## Scope and ownership

Primary Domain: **Identity** (Server context).

- `supabase/schemas/organization_membership.sql` owns the public Identity data plane: `invitations`, `audit_logs`, their RLS policies, and client/`identity_app` ACLs.
- `supabase/schemas/identity.sql` owns the Go-only `verification_codes` expansion.
- `supabase/migrations/<generated>_membership_schema.sql` is the generated expand-only transition between those schema states.
- `server/internal/identity/integrationtest/rls_org_membership_test.go` remains the narrow Identity Module integration seam; it uses real authenticated JWTs against PostgREST and direct `identity_app` transactions only to prove grants.

No Desktop, OpenAPI, or Go command interface changes belong to this ticket.

## Invariants

1. `invitations` and `audit_logs` are RLS-enabled public tables; authenticated clients have SELECT only, while `identity_app` has only the ADR-0008/0009 command and retention permissions.
2. An Owner/Admin reads organization invitations; an invitee reads only a pending invitation matching their JWT email. Owner/Admin alone read audit logs.
3. `verification_codes` gains nullable `action_type`/`target_id`, `consumed` status, and zero-default `failed_attempts` without changing existing issuance behavior.
4. Membership loss removes organization-scoped visibility immediately through existing active-membership helper policies.

## Pre-agreed test seam

The Identity V1 spec fixes the RLS/Data API seam: real anon/authenticated tokens call PostgREST, and a transaction with `SET LOCAL ROLE identity_app` proves the trusted-role ACL. Tests will first fail against the current schema, then pass after the declarative schema and generated migration are applied.

## Verification

Run the focused real-stack RLS test, declarative migration/advisor/history checks, typecheck/lint commands exposed by the repository, then the full required suite. Review the branch against `main` before opening the PR.
