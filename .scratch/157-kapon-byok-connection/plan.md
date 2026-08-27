# Plan — #157 Kapon BYOK AI Provider Connection (AI Creation V1 07/16)

Spec: #150 (authoritative). Parent seam decisions: ADR-0016 (AEAD, reauth
injection, fail-closed credential), ADR-0014/0015 (Go data plane, guards),
ADR-0013 (delivery env shape). High-risk slice: security boundary + public
contract + migration + authz consumption — this plan is the written
pre-implementation plan the repository requires.

## Domain and owners

Primary Domain: AI Creation. Canonical owner: `creation`.

Every new file's narrowest owning boundary:

- `server/internal/creation/domain/connection.go` — aggregate, state enums, ports, errors
- `server/internal/creation/application/connection_service.go` — command orchestration
- `server/internal/creation/infrastructure/secrets/` — master key store + AEAD envelope
- `server/internal/creation/infrastructure/kapon/` — fixed-route `/v1/models` client
- `server/internal/creation/infrastructure/postgres/connections.go` — repository
- `server/internal/creation/interface/http/provider_connection.go` — handlers
- Shared areas touched (called out in PR): `internal/authz` (proof-consumer
  seam), `internal/auditlog` (new actions), `contracts/creation.yaml` +
  `contracts/openapi.yaml`, `server/.env.example`, `deploy/docker-compose.yml`
  (secrets volume env), `scripts/test-creation-integration.sh` (sentinels),
  desktop `app/settings/` (section wiring only) and
  `features/user-management/lib/audit-actions.ts` (vocabulary mirror).
- Desktop feature files stay inside `features/creation/` (api/ui/i18n/model).

## Server design

### Migration `0006_provider_connections.sql` (up-only)

`public.provider_connections`: `id` uuid PK, `admin_state`
CHECK(enabled|paused), `credential_state`
CHECK(checking|valid|invalid|credential_unavailable), `image_capability` /
`video_capability` CHECK(checking|available|unavailable), envelope columns
`envelope_version int`, `credential_key_id text`, `credential_nonce bytea`,
`credential_ciphertext bytea` (all NULL iff `terminated_at` set — CHECK),
`last_checked_at`, `last_check_outcome`
CHECK(completed|temporarily_unavailable) NULLable, `created_by_user_id` FK
users, `created_at`/`updated_at`, `terminated_at`. Singleton: partial unique
index on a constant WHERE `terminated_at IS NULL`. FK index for
`created_by_user_id`. Grants: SELECT/INSERT/UPDATE to `identity_app` (delete
is termination, never row removal).

### Shared proof-consumption seam (`internal/authz`)

`ReauthProofVerifier` interface
`VerifyProof(ctx, principal, action, proof string) error` + proof error
sentinels (invalid/expired/action_mismatch/already_consumed/insecure_transport)
— authz already hosts `SessionAuthenticator` with the same producer/consumer
shape. Identity `Module.ReauthProofs()` returns an adapter over its reauth
service (single consumption, own audit row, own committed tx — downstream
failure never restores). Creation `Deps.ReauthVerifier` consumes it; no
module-to-module import. Creationhttp duplicates the 1-line
secure-transport check (same precedent as the duplicated error-envelope
writer), honoring the private-proxy `X-Forwarded-Proto: https` marker.

### Master key + AEAD (`infrastructure/secrets`)

- Master key store rooted at `NEVIX_CREATION_SECRETS_DIR` (required env).
  One 32-byte CSPRNG key file, dir 0700, file 0600, atomic create
  (temp write 0600 → fsync → rename → fsync dir). Load validates dir/file
  perms and exact 32-byte size; violations return typed unreadable/corrupt
  errors.
- Non-silent regeneration rule: with ciphertext present (an active
  connection exists), missing/corrupt/too-open key never regenerates — the
  connection reads `credential_unavailable`. Explicit reauthenticated
  flows (create when no ciphertext exists; replace as the sanctioned
  recovery) may establish the key file first, then seal the new ciphertext.
- Envelope v1: AES-256-GCM, random 12-byte nonce, AAD =
  `nevix.creation.provider_credential.v1|<connectionID>|kapon` (binds
  connection identity, provider, purpose); stored columns: version, key ID
  (SHA-256 of key material, hex-truncated), nonce, ciphertext. Tamper or
  AAD swap fails open → `credential_unavailable`.

### Kapon check client (`infrastructure/kapon`)

Fixed reviewed base route `https://models.kapon.cloud`
(`KAPON_BASE_URL` env override: required to be https, or http on a loopback
host for the fake-Kapon test harnesses; unset → fixed default; never exposed
to Desktop; process-wide, not per-connection, no fallback). Check = one
`GET /v1/models` with `Authorization: Bearer <candidate>`; 200 → token valid,
visibility of allowlisted models `doubao-seedream-5.0-lite` (image) /
`doubao-seedance-2-5` (video) decided independently; 401/403 → token invalid;
timeout/429/5xx/transport → transient (never rewrites persisted states).
No media generation, no request IDs or raw bodies surfaced.

### Application service

External Provider calls never run inside the DB transaction; commands:

- `Configure` (proof action `provider_connection.create`): secure transport
  required → consume proof (independently committed) → refuse when an active
  connection exists → establish master key (no ciphertext can exist) → check
  candidate → invalid/transient rejects the candidate with nothing persisted
  (proof stays consumed) → one tx: insert connection (states from check),
  audit `provider_connection_created`. Concurrent create loses on the
  singleton index → `provider_connection_exists`.
- `Replace` (proof `provider_connection.replace`): secure transport →
  consume proof → load active connection → check candidate with the *old*
  key untouched → failure discards candidate (old envelope + capabilities
  byte-identical); success = one tx: envelope + states atomically switched
  (even if only one media model visible — the other media independently
  `unavailable`), audit `provider_connection_replaced`. Master key: reuse
  when loadable; else (recovery) establish new key file first.
- `Delete` (proof `provider_connection.delete`): secure transport → consume
  proof → one tx: `terminated_at = now()`, envelope columns NULLed (history
  identity retained), audit `provider_connection_deleted`. No Task table
  exists yet — the in-flight guard arrives with T09 (issue wording).
- `Pause`/`Resume`: valid admin session only; one tx flips `admin_state`,
  audit row each.
- `Recheck`: valid admin session only; decrypt credential (key failure → tx
  writes `credential_unavailable` + both media `unavailable`, fail closed,
  no regeneration) → check → one tx persists new credential/media states +
  `last_check_outcome` (transient outcome persists nothing but
  `last_check_outcome=temporarily_unavailable`), audit
  `provider_connection_checked`.
- Views: AdminView (id, admin/credential/media states, timestamps,
  `needs_attention` derived) — never key, endpoint, model IDs, request IDs,
  raw errors; MemberView via `GET /creation/media-capabilities` — per-media
  status + stable reason + stable action advice only.

### Routes (all new paths in `contracts/creation.yaml`, add-only)

| Method/Path | Guard | Notes |
| --- | --- | --- |
| GET `/creation/provider-connection` | Admin | 404 `provider_connection_not_configured` when none |
| POST `/creation/provider-connection` | Admin | configure `{proof, provider_key}` → 201 |
| PUT `/creation/provider-connection/credential` | Admin | replace `{proof, provider_key}` |
| PATCH `/creation/provider-connection` | Admin | `{admin_state}` pause/resume |
| POST `/creation/provider-connection/recheck` | Admin | manual recheck |
| DELETE `/creation/provider-connection` | Admin | body `{proof}` → terminal view |
| GET `/creation/media-capabilities` | ActiveUser | member surface |

Stable error codes: `provider_connection_not_configured`,
`provider_connection_exists`, `provider_credential_invalid`,
`provider_check_temporarily_unavailable`, `secure_transport_required`,
`reauth_proof_invalid|expired|action_mismatch|already_consumed`,
`invalid_request`, `forbidden`, `unauthorized`, `internal_error`.

New audit actions: `provider_connection_created|replaced|paused|resumed|checked|deleted`
with sanitized metadata (connection id + outcome states only).

## Desktop design

- New Settings section `aiCreation` (all users see it; content differs by
  role; `ADMIN_SETTINGS_SECTIONS` unchanged). Sidebar icon under Server
  group. Registry + nav wiring only in `app/settings/`.
- `features/creation/api/provider-connection-http.ts` — typed client
  (bearer per call, JSON error-code branching, no key persisted).
- `features/creation/ui/provider-connection-settings.tsx` — the AI Creation
  Settings card: no-connection, configure/replace (key input → proof →
  submit), recheck, pause/resume, delete confirmation, `credential_unavailable`
  recovery guidance, `secure_transport_required`/proof errors mapped to
  stable advice. Proof acquisition stays a prop
  `acquireProof(action: 'create'|'replace'|'delete') => Promise<{proof}|undefined>`;
  `app/settings` composes the Authentication-owned `ReauthenticationDialog`
  (peer features never import each other).
- Member surface: same section renders status-only view (per-media status,
  reason, action advice) — no management commands attempted.
- i18n zh-CN + en inside `features/creation/i18n/resources.ts`; settings nav
  label in `app/i18n`.
- `features/user-management/lib/audit-actions.ts` mirrors the six new audit
  actions (with unit test lockstep).

## Tests

Server (no production token anywhere; fake Kapon = in-process httptest):

- Unit: envelope seal/open/AAD binding + tamper; kapon client (visibility
  parse, 401 invalid, 5xx/timeout transient); key file perms/atomicity/
  corruption matrix on temp dirs.
- Package-local real-DB: singleton partial unique index conflict.
- Integration (`integrationtest`, fake Kapon injected via `Deps`): permission
  matrix (401/403/member), configure happy path (states, audit, ciphertext
  not plaintext in DB, singleton conflict), invalid candidate leaves no row
  and consumes the proof, secure_transport_required, replace failure keeps
  old envelope byte-identical + replace success with one-media visibility,
  pause/resume/recheck semantics incl. transient no-rewrite, delete retains
  identity + clears ciphertext, master-key loss/corruption →
  `credential_unavailable` fail-closed without silent regeneration, recovery
  via replace, AAD/ciphertext tamper via owner-pool DB edit → unavailable.
  New sentinels appended to `scripts/test-creation-integration.sh`.

Desktop:

- Unit: provider-connection client (URL/method/bearer/error mapping).
- Component (Playwright CT, in-memory ports): no-connection, configured,
  checking, credential_unavailable, secure_transport_required, pause/resume,
  replace flow, delete confirmation, member status-only.
- E2E: settings surface reaches server — admin sees not-configured +
  configure requires reauth; member sees status-only; HTTP-transport
  configure attempt answers `secure_transport_required` (real server
  assertion). Fake-Kapon E2E configure happy path only where the harness can
  point the server at a local fake (`KAPON_BASE_URL` loopback override).

## Sequence

1. contracts → 2. authz seam + identity accessor → 3. migration →
4. secrets/kapon/domain (+unit tests) → 5. application + repo →
6. http + module + main wiring + audit actions → 7. env plumbing →
8. server integration tests → 9. desktop feature → 10. desktop tests →
11. full gates (`go vet`, `go test`, `make test-creation-integration`,
desktop unit/component/e2e) → 12. `/code-review` → PR (squash) →
issue #157 acceptance checklist verified item by item.

## Known deliberate scope lines

- No background periodic check; recheck is admin-initiated only.
- No in-flight-task delete guard (no Task aggregate exists until T09); issue
  wording records T09 as the owner of that guard.
- `KAPON_BASE_URL` is a process-wide startup selector for the reviewed fixed
  route (test harnesses need the fake), not the out-of-scoped per-connection
  Endpoint configurability; Desktop never sees it.
- No key rotation UI; no usage/price facts; no webhook work.
