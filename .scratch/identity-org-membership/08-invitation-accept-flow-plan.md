# 08 — Invitation Accept Flow implementation plan

## Scope and ownership

- **Primary Domain:** Desktop **Organization Domain**. The renderer's
  `features/organization/` owns the pending-Invitation read, startup decision,
  acceptance workflow, and localized picker interaction. The thin
  `app/routes/select-organization.tsx` remains composition only.
- **Profile follow-up seam:** `features/profile/` owns the RLS read and the
  definition of whether the global Profile is complete. `renderer/src/app/`
  injects that public capability into Organization startup; neither Feature
  imports the other. Organization onboarding keeps Profile completion and
  first-Organization creation as independent requirements.
- **Supporting Identity data plane:**
  `supabase/schemas/organization_membership.sql` owns the two safe display
  snapshots on `public.invitations`; its generated expand-only migration owns
  the transition. `server/internal/identity/invitations/` owns writing those
  snapshots and distinguishing an old, superseded code from a wrong code.
- **Shared areas:** `contracts/identity.yaml` documents the accepted command's
  new response header; `server/internal/identity/cors.go` exposes that header
  to the Desktop origin. These are narrow public-interface changes and must be
  called out with their tests in the PR description.

## Contract correction

The resolved tickets expose only `organization_id` and no inviter data to a
pending invitee. The Organization table, Profiles, and Audit Logs correctly
remain hidden until Membership exists, so no client relationship query can
faithfully render the locked `picker.inviteLine` copy. The smallest compliant
correction is to persist these non-secret display snapshots on the Invitation
itself:

- `organization_name text` — set by Create/Resend from the Organization read
  already required by the trusted command.
- `inviter_display_name text` — set by Create/Resend from the acting
  Owner/Admin's existing Audit snapshot. They remain nullable for historical
  rows; the Desktop uses a localized generic inviter only for such legacy
  records, never an opaque organization id.

No Organization, Profile, Audit Log, service-role credential, new public RPC,
or RLS policy is exposed. Existing Invitation `SELECT` policy remains the
access-control decision; it reveals these columns only on a row already
visible to the invitee or Organization Owner/Admin.

The command error body stays byte-for-byte `{error,message}`. On every server
recorded wrong code attempt and exhaustion response, the command sends
`X-Invitation-Code-Attempts-Remaining` and CORS exposes it. The renderer uses
the header as the exact value for the finalized `codeInvalid` text instead of
guessing across a restart or another device. A submitted historical,
superseded code is detected without incrementing the current code's failure
count and returns explicit `invitation_code_invalidated`, so the UI can give
the required resend guidance.

## Invariants

1. Pending invitees can read only their own pending Invitation projection;
   nonmembers still cannot query Organization, Profile, Membership, Audit Log,
   verification-code, or other invitee data. The Desktop additionally filters
   the RLS projection by its normalized Session email so an Owner/Admin never
   sees their outgoing invitations as invitations to accept.
2. Create and Resend write the display snapshots in the same `identity_app`
   transaction as Invitation, code, Outbox, and Audit Log writes. Resend
   refreshes the snapshots to describe the freshly issued invitation.
3. The exact five-attempt enforcement remains server-owned. A wrong code
   consumes one attempt, the fifth reports zero remaining, and a superseded
   historical code consumes none.
4. Every authenticated startup reconstructs Profile completion from the
   current User's RLS-visible `profiles` row; registration's temporary memory
   signal is never authoritative across a restart or another device. A missing
   Profile forces the Profile onboarding step before the picker or App Shell.
   Independently, a pending Invitation suppresses only first-Organization
   creation and takes the post-Profile path to the picker, even when remembered
   or sole Membership rules would otherwise auto-enter.
5. Successful acceptance rereads active Memberships under RLS before entering
   the Organization, so the name and current authorization come from the
   authoritative data plane rather than from the trusted-command response.

## Pre-agreed test seams

1. **Identity RLS/Data API seam:** real authenticated PostgREST tokens prove
   the invitee gets the two display snapshots on its one pending Invitation,
   while the parent Organization remains unreadable.
2. **Identity command HTTP seam:** real PostgreSQL plus the mounted command
   proves snapshot writes, historical-code invalidation, response header count,
   error codes, and no accidental failure-count consumption.
3. **Organization model seam:** the existing `resolveStartupBranch` unit test
   proves a pending Invitation routes to the picker before all remembered/sole
   Membership auto-entry cases.
4. **Desktop Playwright e2e seam:** a real Go server, Supabase, and Mailpit
   prove pending visibility, six-digit interaction, exact failed-attempt
   feedback, expiration/revocation/invalidated guidance, and successful entry
   into the App Shell. A verified User with no Profile closes the first launch,
   signs in with a fresh device directory, must save `display_name`, accepts a
   valid Invitation, and is proved to join only the invited Organization. The
   happy paths and revoked-Invitation projection cleanup are `@smoke`.

## Delivery and verification

Use the declarative schema workflow: edit the schema first, generate and
review the migration, then reset/list/diff/advisor-check the local stack. Run
targeted Go, unit, and E2E checks after each vertical slice; after the final
edit run the required final-state evidence wrapper, review the final diff, and
run the relevant full suite. Rollback is code-only; the two nullable,
expand-only snapshots and the new response header may safely remain.
