# Identity V1 Spec

Status: Wayfinding baseline — not implementation-ready

This document captures decisions already confirmed during the Identity V1 grilling session. It is the baseline for the remaining Wayfinder tickets: later tickets may refine implementation contracts, but must not silently reopen these decisions.

Authoritative context:

- [Identity V1 Wayfinding Map](./map.md)
- [Desktop domain language](../../apps/desktop/CONTEXT.md)
- [ADR-0004: Supabase data plane and Go trusted-execution seam](../../docs/adr/0004-supabase-go-trusted-execution-seam.md)

## Destination

Produce an implementation-ready Identity V1 specification covering domain behavior, Supabase schema/RLS, Desktop and Go interfaces, Session/email/audit security, migrations, and acceptance criteria for three independently mergeable vertical slices.

The destination is planning and handoff. It does not include feature code, migrations, cloud resources, or the implementation PRs themselves.

## Delivery slices

### Identity Foundation

- Supabase public configuration and schema baseline
- Electron security and persistent Session
- Email/password registration, verification, login, logout, and password recovery
- Global Profile
- First Organization creation and Active Organization

### Organization Membership

- Invitation and acceptance
- Multi-Organization membership and switching
- Owner/Admin/Member authorization
- Member exit and removal
- Organization Audit Log
- SMTP Outbox and the confirmed notification matrix

### Identity Governance

- Ownership Transfer
- Organization Deletion and User Deletion
- Email Change, Security Lock, and exceptional recovery
- Automatic Session revocation after password security events

Each slice must build, test, merge, and roll back independently without temporary compatibility scaffolding.

## Domain baseline

The canonical definitions live in `apps/desktop/CONTEXT.md`. The following relationships are fixed:

- An Organization is the enterprise tenant and owns business data, files, usage credits, and subscriptions.
- A User is a natural person and may belong to multiple Organizations.
- A global Profile contains a required display name and optional avatar. It is shared across Organizations; login email is not Profile data.
- A Membership connects a User to an Organization and carries its role and lifecycle.
- Even a one-person Organization owns its resources; business resources are never directly owned by a User.
- The UI has one Active Organization at a time. Remembering it on a device is a convenience, never authorization evidence.

## Registration and onboarding

- V1 supports email and password only.
- Registration requires verified email.
- An unverified User cannot create an Organization or accept an Invitation.
- V1 excludes anonymous login, Magic Link, social OAuth, SAML SSO, SCIM, and MFA.
- A standalone signup verifies email and then creates the first Organization.
- A signup carrying a valid Invitation verifies the same email and joins the target Organization without creating an extra Organization.
- A User may later create additional Organizations.
- An expired Invitation neither joins a User nor silently creates an Organization.

## Organization roles

### Owner

- Every Organization has exactly one Owner.
- The Organization creator is its first Owner.
- Owner is the final-control role and cannot be directly removed or downgraded.
- Owner alone may manage Admin roles, initiate Ownership Transfer, and delete the Organization.

### Admin

- An Organization may have multiple Admins.
- Admin may invite and remove ordinary Members and change ordinary Organization settings.
- Admin cannot promote, demote, or remove another Admin.
- Admin cannot operate on Owner, transfer ownership, or delete the Organization.

### Member

- Member may use business capabilities but cannot administer members, roles, or Organization settings.
- Every accepted Invitation creates a Member. Direct invitation as Admin is not supported.
- Only Owner may promote an existing Member to Admin.

V1 excludes custom roles, fine-grained permissions, and Suspended Membership.

## Invitation

- Owner or Admin may invite an email address.
- Invitation is bound to the normalized target email and may only be accepted by a User with the same verified email.
- Invitation is a one-time credential valid for seven days.
- Owner or Admin may revoke a pending Invitation.
- Resending creates a new credential and invalidates the previous one.
- A forwarded Invitation cannot be accepted by a different email identity.
- Removed Users may later join through a new Invitation; old and new Membership history remain distinct.

## One-time verification codes

- V1 uses codes entered in Desktop rather than an Electron custom protocol.
- Registration verification, password recovery, new-email verification, Invitation acceptance, and Ownership Transfer acceptance use one-time codes.
- Codes contain six numeric digits.
- Each code is bound to the User/email, action type, and target object.
- Each code permits at most five attempts.
- Resend cooldown is 60 seconds; a new code invalidates the previous one.
- The same email may receive at most five codes per hour, with an additional IP-level limit.
- The server stores only a hash and never logs or returns plaintext.
- Pre-login errors do not reveal whether an email is registered.
- The sole link-based exception is the old-email “not me” Security Lock flow, served by a minimal Go HTTPS confirmation page.

## Membership exit and removal

- Admin and Member may leave an Organization.
- Owner must complete Ownership Transfer before leaving.
- Removal or exit immediately ends Organization access.
- If the removed Organization is active, Desktop exits that Organization context immediately.
- Files, tasks, and generated results created by the departed User remain owned by the Organization.
- Historical attribution remains and displays the User as Former Member.
- Ending one Membership does not end the User Session or affect access to other Organizations.

## Ownership Transfer

- The target must already be an Admin.
- Current Owner reauthenticates and starts the transfer.
- The target Admin has 24 hours to accept.
- Until acceptance, current Owner remains the only Owner and may cancel the transfer.
- Only one Pending Ownership Transfer may exist per Organization.
- On acceptance, the target becomes Owner and the former Owner becomes Admin.

## Organization Deletion

- Only Owner may initiate Organization Deletion.
- Initiation requires reauthentication.
- Organization enters Pending Deletion for seven days.
- During Pending Deletion, members may read and export data but cannot create tasks, invite members, change roles, transfer ownership, or change subscriptions.
- Cancelling deletion lowers risk and does not require reauthentication.
- Only current Owner may cancel.
- Initiation and cancellation notify every member.
- At expiry, Organization data and its Audit Log enter permanent deletion.
- Infrastructure backups may retain deleted data for at most 30 further days and are not product-queryable or product-restorable.

## User Deletion

- User must reauthenticate.
- A User that owns any Organization must first transfer every ownership.
- Initiation signs out all devices, ends every Membership, and revokes pending Invitations.
- User enters Pending User Deletion for seven days and cannot log in normally.
- Cancelling deletion lowers risk and does not require reauthentication.
- Cancellation uses verified email.
- At expiry, Auth credentials and Profile are deleted.
- Organization resources remain owned by each Organization; retained attribution becomes Former Member and uses a non-login stable identifier where audit requires it.

The effect of cancelling User Deletion on already-ended Memberships is not yet specified. Remaining tickets must decide whether restoration recreates Memberships, restores their previous rows, or restores only the User account.

## Profile and login email

- Profile is global and contains required display name and optional avatar.
- V1 excludes Organization-specific nickname, title, department, phone number, and unique username.
- Language Mode remains device-local and is not Profile data.
- Changing display name or avatar updates the User representation in every Organization.

### Email Change

- User reauthenticates using the current password.
- Only the new email must be verified, within 24 hours.
- Old email receives an immediate, non-disableable security notification but does not need to approve.
- Email Change preserves User ID, Memberships, roles, and Ownership.
- A future enterprise-managed SSO/SCIM account will not self-edit email; that future policy is outside V1.

### Security Lock

- The old-email notification contains a one-time “not me” credential valid for 24 hours.
- Opening it shows a confirmation page and performs no action automatically.
- Explicit confirmation freezes the User and revokes every Session.
- It does not directly change the email back.
- Recovery verifies the old email, resets the password, revokes the Email Change, and then removes Security Lock.
- This is exceptional account protection, not general multi-device Session management.

## Reauthentication

- Reauthentication means entering the current password.
- A successful reauthentication remains valid on the current device for five minutes.
- It is required for:
  - Ownership Transfer initiation
  - Organization Deletion initiation
  - User Deletion initiation
  - login email change
  - password change
- It is not required for:
  - cancelling Organization Deletion or User Deletion
  - Admin promotion, demotion, or removal
  - Invitation and ordinary Member removal
  - ordinary Organization settings
- Admin changes instead use explicit confirmation, Audit Log, and the confirmed direct-recipient email notification.

## Session

- A User may have concurrent Sessions on multiple devices.
- V1 only supports login and logout on the current device.
- V1 has no activity-device list, per-device remote revocation, or manual “logout all other devices” action.
- Session belongs to User rather than Organization.
- access token lifetime is one hour.
- Session requires re-login after 14 days without activity.
- Session has a 90-day absolute maximum.
- Supabase enforces time-box and inactivity controls on refresh; acceptance tests must account for a still-valid access token until its one-hour expiry.

### Password events

- Forgotten-password reset revokes all old Sessions and establishes a new Session on the current device.
- An authenticated password change preserves a refreshed current-device Session and revokes all other Sessions.
- Security Lock revokes all Sessions.
- These automatic security actions do not create a general Session-management UI.

### Desktop persistence

- Session persists across Desktop restarts.
- refresh token is encrypted with Electron `safeStorage` and persisted by the main process.
- renderer holds the current access token only in memory and does not store Session in `localStorage` or plaintext JSON.
- IPC only stores, reads, and clears encrypted Session state; it does not proxy Supabase business requests.
- If safe encryption is unavailable, Session is not persisted and login is required again.
- Linux `safeStorage` backend `basic_text` is treated as unavailable even if Electron reports encryption available.
- Current-device logout clears persisted Session.

## Active Organization

- Desktop operates in exactly one Active Organization at a time.
- Lists, files, tasks, and credit displays are limited to that Organization.
- Switching reloads Organization-scoped data; V1 has no cross-Organization aggregate view.
- Device may remember the last selection, but RLS and Membership determine authorization.
- If startup validation finds the User has lost that Membership, Desktop requires another selection.

## Organization Audit Log

- Audit Log is immutable to Organization members.
- It records:
  - Invitation creation, resend, revocation, and acceptance
  - Membership join, exit, and removal
  - role changes
  - Ownership Transfer
  - Organization Deletion initiation and cancellation
  - ordinary Organization setting changes
- It does not become a general business-activity analytics system.
- Owner and Admin may view and export it; Member may not.
- Active Organizations retain a rolling 365 days.
- Pending Deletion preserves view/export.
- Permanent Organization deletion removes it through the same deletion process, subject to the 30-day backup ceiling.

## Email notification matrix

| Event | Recipients |
| --- | --- |
| Ownership Transfer | former Owner, new Owner, all Admins |
| Admin promotion, demotion, or removal | affected User and Owner |
| Organization Deletion initiation or cancellation | all members |
| User Deletion | affected User |
| login email or password change | affected User |
| Invitation | invited email recipient |
| Member removal | removed User |
| Member voluntary exit | no email; Audit Log only |
| ordinary Organization setting change | no email; Audit Log only |

## Authorization source of truth

- Supabase `auth.users` owns authentication credentials only.
- Product data uses separate Profile, Organization, Membership, Invitation, Audit Log, Outbox, and security-state tables.
- Membership is the only authorization source for Organization role and access.
- Organization roles are not trusted from JWT `user_metadata` or `app_metadata`.
- Every tenant-owned business row carries `organization_id`.
- RLS checks the current User against the current Membership for that `organization_id`.
- Active Organization is never authorization evidence.
- Columns used by foreign keys and RLS lookups require appropriate indexes.
- Every exposed table has RLS plus explicit, least-privilege GRANTs.

Exact table layout, constraints, RLS policies, and GRANT matrix remain decision-ticket work.

## Supabase data plane and Go trusted execution

ADR-0004 remains authoritative.

Desktop directly uses Supabase for:

- ordinary Auth and Session refresh
- RLS-protected reads and ordinary CRUD
- own Profile updates
- ordinary Storage and Realtime access when later features require them

Go trusted commands own:

- Organization creation plus first Owner
- Invitation creation, revocation, and acceptance
- Membership removal and role changes
- Ownership Transfer
- Organization/User Deletion and recovery
- Email Change exceptional lock and recovery
- cross-write transactions, Audit Log, email Outbox, and asynchronous orchestration

Go validates the caller JWT and uses a dedicated least-privilege PostgreSQL role. It does not proxy ordinary login or ordinary tenant reads.

V1 does not use Supabase Edge Functions. They may be reconsidered only after a concrete edge-latency or independent-deployment need appears.

## Go module shape

- A single private `server/internal/identity` module owns Identity V1 behavior.
- It owns JWT/JWKS verification privately.
- It owns User/Profile security, Organization/Membership/Invitation governance, ownership, deletion, audit, and Outbox behavior.
- It does not own AI jobs, business file state, credits, billing, or subscription implementation.
- It exposes only the actual registration and command interface required by the three slices.
- V1 does not create `pkg/auth`.
- When the first real Auth Admin API use case arrives, add a concrete private client inside `internal/identity`.
- Do not prebuild a generic Supabase adapter. Extract a minimal shared interface only after a second real consumer, through a separate shared-area review.
- If the existing empty `server/pkg/auth/.gitkeep` remains when implementation starts, its treatment must be explicit; it does not authorize using that shared directory.

## JWT and credentials

- Every environment uses ES256 with the P-256 curve.
- Go selects and caches public JWKS keys by valid `kid`, supports overlap during rotation, and validates `alg=ES256`, `crv=P-256`, signature, issuer, `aud=authenticated`, expiry, and required identity claims.
- There is no HS256 or shared `JWT_SECRET` fallback.
- An environment that fails this baseline must upgrade Supabase Auth before use.
- Acceptance confirms the self-hosted instance publishes an EC P-256 key with a valid `kid`.
- Desktop only receives Supabase API URL and `sb_publishable_...`.
- Go may receive `sb_secret_...` only inside a concrete high-risk Auth Admin use case.
- Supabase secret key never substitutes for a PostgreSQL connection.
- Go database DSNs use dedicated least-privilege roles and remain separate from every JWT and API key.

## Database workflow

- Use declarative `supabase/schemas/` files as the expected business-database state.
- Generate, review, and commit migrations as cross-environment deployment records.
- Do not make schema/RLS changes only through Studio.
- Every change passes advisors, migration-history checks, RLS/GRANT security review, and target-database testing.
- Do not modify Supabase-owned `auth`, `storage`, `realtime`, or vendor migration state through business schema files.
- Supabase infrastructure compatibility and initialization on external PostgreSQL are separate infrastructure assets, not business migrations.

## Environment configuration

Desktop build-time public configuration:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Rules:

- Commit `.env.example`; keep values in ignored local files or CI.
- Validate required configuration at startup and fail explicitly when absent.
- Production has no user-editable Supabase URL.
- Development, staging, and production use separate builds.
- Desktop never receives an RDS hostname, PostgreSQL credential, Supabase secret key, or signing private key.
- Future database migration should preserve a stable Supabase API domain so Desktop does not observe the RDS change.

Go configuration keeps Auth issuer/JWKS, any concrete Supabase secret, and each database DSN independently managed.

## Email and Outbox

- GoTrue sends registration verification, password recovery, and new-email verification through SMTP.
- `internal/identity` persists Invitation, Ownership Transfer, security, and Organization Deletion messages in a transactional Outbox.
- Domain state, Audit Log, and Outbox row commit in the same database transaction.
- A Go worker sends and retries. Temporary SMTP failure does not roll back a completed governance command.
- The worker retries with exponential backoff at 1m, 5m, 15m, 1h, and 6h, for at most five attempts per message.
- A message carrying a one-time code is never retried beyond the code's remaining validity; an invalidated or expired code makes the message terminal immediately.
- After retries are exhausted the Outbox row is marked failed and retained, not deleted; failed rows are V1's only operational visibility, with no alerting or redelivery tooling.
- Rate limiting, cooldown, and code invalidation are enforced synchronously at command handling before an Outbox row is written; the worker contains no business rules.
- GoTrue and `internal/identity` rate-limit email sending independently; neither reads the other's counters.
- Local and CI environments use a captured mailbox.
- Production provider is selected through deployment configuration.
- V1 implements the standard SMTP path directly and does not create a hypothetical provider adapter interface.
- GoTrue templates and identity templates live with their owner while sharing the product's localized brand language.

Template inventory and operational visibility beyond retained failed rows remain open.

## Desktop implementation constraints

- Supabase password Auth Block is a UI starting point, not an architecture template.
- Copy only required password-form interaction and shadcn primitives.
- Do not import social login, Magic Link, Next.js assumptions, or its router structure.
- Identity owns Supabase client, Session state, and localized error mapping.
- Business UI remains feature-local.
- Adding a genuinely shared shadcn primitive to `components/ui/` requires the ticket to name the shared-area exception and receive additional review.
- All Localized Surface text supports Simplified Chinese and English.
- Global styles remain only in `app/globals.css`.
- V1 does not add React Router.
- `App` selects unauthenticated identity flow or authenticated app shell from Session state.
- Identity subflows use explicit feature-local state; Organization management uses application state, settings surfaces, and dialogs.

Exact state model and visual behavior remain prototype work.

## Electron security baseline

- Explicit `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`.
- preload exposes only narrow typed IPC required for encrypted Session persistence.
- CSP `connect-src` allows only the exact environment Supabase HTTP/HTTPS and Realtime WS/WSS origins.
- Production allows HTTPS/WSS only; wildcard origins are forbidden.
- renderer top-level navigation is denied by default through `will-navigate`.
- new windows are denied by default.
- A URL may reach `shell.openExternal` only after complete parsing and match against an HTTPS protocol/origin/path allowlist.
- Electron integration tests cover sandboxing, CSP, external-navigation denial, and Session restart behavior.

These are required Identity Foundation changes, not a general Electron refactor.

## SMTP and action-link exception

V1 does not register an Electron custom protocol and does not build a general deep-link or web-action gateway.

The Security Lock “not me” flow is the only HTTPS action page. It must:

- use a one-time credential valid for 24 hours;
- render a confirmation page on GET without mutating state;
- mutate state only after explicit confirmation;

## Alibaba Cloud RDS boundary

- Identity V1 uses the current internal self-hosted Supabase development environment.
- V1 does not provision Alibaba resources, initialize RDS, migrate data, or build dual-database compatibility.
- A separate infrastructure gate must validate exact PostgreSQL/Supabase versions, permissions, roles/schemas, extensions/preload libraries, logical replication, TLS, connection budget, HA, PITR, restore, and end-to-end Supabase behavior.
- Auth/JWKS, RLS/Data API, Storage, Realtime, Go transactions, and Outbox must pass against a production-equivalent disposable RDS instance before go-live.
- Current research status is conditional no-go until that gate passes.

## Verification strategy

- Shared internal Supabase is for manual development and smoke tests only.
- Repeatable CI uses a version-pinned temporary Supabase/PostgreSQL stack and captured mailbox.
- CI starts from an empty database and applies committed migrations.
- It runs advisors, migration-history checks, and RLS/GRANT review.
- RLS tests use real `anon` and authenticated tokens and prove cross-Organization isolation and immediate loss of access after Membership termination.
- Go tests cross `internal/identity`'s external command/HTTP interface and verify JWKS, transactions, Audit Log, and Outbox without testing private implementation details.
- Electron Playwright covers registration/login, restart persistence, Organization switching, offline startup, logout clearing, CSP, navigation, and sandbox behavior.
- Native Keychain/DPAPI/Secret-Service behavior requires platform-native acceptance; Linux `basic_text` must fail persistence.
- Do not add a frontend unit-test framework solely for these slices.

Exact CI commands, pinned artifacts, headless/native split, and slice-specific gates remain open tickets.

## Confirmed out of scope

- Feature implementation in the Wayfinder effort
- Alibaba RDS provisioning or migration in Identity V1
- Edge Functions
- anonymous, Magic Link, social OAuth, SAML SSO, SCIM, and MFA
- custom roles and fine-grained authorization
- Suspended Membership
- device/session inventory and manual remote revocation
- Electron custom protocol and generic deep linking
- general web frontend and frontend router
- general activity analytics
- billing, AI task, and business file-state implementation

## Known gaps for remaining tickets

The following are intentionally unresolved and must not be guessed during implementation:

- password strength, lockout, abuse prevention, and precise recovery edge cases;
- User Deletion cancellation behavior for previously ended Memberships;
- exact relational schema, data types, constraints, indexes, state transitions, and avatar Storage policy;
- exact GRANT and RLS policy matrix;
- trusted-command request/result/error/idempotency/concurrency interface;
- Desktop state model and concrete UI behavior;
- Outbox template inventory and operational visibility beyond retained failed rows;
- exact CI harness and native-platform acceptance split;
- ADR and architecture-ticket set;
- slice-level acceptance, rollback, and additional-review gates;
- observability and support tooling that become necessary only after concrete failure modes are known.
