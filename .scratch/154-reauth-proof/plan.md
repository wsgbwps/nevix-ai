# High-risk plan — issue #154: exact-action Reauthentication Proof

Policy trigger: authentication/authorization + public contract + persistent
data/migration. Plan written before implementation, per AGENTS.md.

- **Spec source:** #150 (AI Creation V1 end-to-end spec, slice 4/16), ADR-0016
  (trusted seams), ADR-0015 (guards), ADR-0009 (shared Audit Append), issue #154.
- **Acceptance boundary:** the 8 acceptance criteria of #154.
- **Fixed point:** `main` @ `1713e05`.
- **Primary Domain:** Identity (server) — proof issuance/consumption lifecycle.
  Desktop `authentication` feature owns the reusable password-confirmation
  surface only; no new Desktop Domain is created (no Electron Main/IPC work).
- **Task-owned paths (frozen):**
  - `server/internal/migration/migrations/0004_reauth_proofs.sql` (new)
  - `server/internal/identity/reauth/` (new package: `reauth.go`,
    `reauth_test.go`, `reauth_integration_test.go`)
  - `server/internal/identity/auth/` (add `VerifyCurrentPassword` on Service)
  - `server/internal/identity/module.go`, `routes.go` (wiring only)
  - `server/internal/auditlog/log.go` (two new Action constants — shared area)
  - `server/internal/identity/integrationtest/` (`reauth_proof_test.go` new,
    `harness_test.go` truncate list += `reauth_proofs`)
  - `contracts/identity.yaml` (two new paths)
  - `deploy/nginx/nginx.conf` (add issuance endpoint to `nevix_auth` zone)
  - `scripts/test-identity-integration.sh` (+= representative sentinels)
  - `apps/desktop/src/renderer/src/features/authentication/`:
    `api/reauth-client.ts` (new), `ui/reauthentication-dialog.tsx` (new),
    `ui/password-input.tsx` (moved from `authentication-surface.tsx`, unchanged
    behavior), `i18n/resources.ts` (reauth keys), `index.ts` (exports)
  - `apps/desktop/tests/unit/reauth-client.test.mts` (new)
  - `apps/desktop/tests/component/reauthentication-dialog.spec.tsx` (new)

## Design decisions

1. **Closed exact-action set** (fixed by spec, no others pre-built):
   `provider_connection.create`, `provider_connection.replace`,
   `provider_connection.delete`. Enforced in request validation (Go + desktop
   client), the audit metadata, and a DB CHECK constraint.
2. **Storage:** new table `public.reauth_proofs` — `token_hash` (sha256 of a
   32-byte CSPRNG base64url token; token body never stored), `user_id` FK,
   `action`, `expires_at` = now()+5 min (DB clock), `consumed_at` nullable.
   Grants: SELECT/INSERT/UPDATE/DELETE for `identity_app` (sweep needs DELETE).
   FK index on user_id; index on expires_at for the sweep.
3. **Issuance** `POST /identity/admin/reauth/proofs` (GuardAdmin, default
   password gate): secure-transport proof required; per-email login limiter
   shared with Login (same credential under attack); bcrypt verification of the
   current password against the committed hash with a fresh status read; proof
   row + `reauth_proof_issued` audit row in one writetx transaction.
   Response `{proof, action, expires_at}`.
4. **Consumption** `POST /identity/admin/reauth/proofs/consume` (GuardAdmin,
   secure transport): one writetx transaction = `SELECT … FOR UPDATE` by
   token_hash + issuer binding (`user_id = principal`) → discriminate
   invalid/expired/action-mismatch/consumed → single `UPDATE consumed_at`.
   Atomic single transition; never restored (own committed transaction, so a
   later downstream failure cannot roll it back — the fail-closed contract).
   Audit `reauth_proof_consumed` rides the same transaction. A standalone
   consume endpoint also gives every stable failure code a public-contract
   home now; slice 7's Creation commands reuse the same service function
   through the injected seam (ADR-0016) without a second implementation.
5. **Secure transport:** `r.TLS != nil` OR exactly `X-Forwarded-Proto: https` —
   the only marker the official private proxy writes after stripping
   client-supplied values (deploy/nginx, #152 baseline). Otherwise
   `400 secure_transport_required` on both endpoints.
6. **Stable error contract:** issuance 200/400 invalid_request/400
   invalid_action/400 secure_transport_required/401 unauthorized/401
   invalid_credentials/403 forbidden/403 password_change_required/429
   login_rate_limited; consumption 200/400 invalid_request/400 invalid_action/
   400 secure_transport_required/400 reauth_proof_invalid (unknown token or
   not the caller's)/409 reauth_proof_action_mismatch/
   409 reauth_proof_already_consumed/410 reauth_proof_expired.
7. **Sweep:** daily loop deletes `expires_at < now()` rows (expired proofs are
   already invalid at lookup; sweep only reclaims rows). Module `RunWorkers`
   runs the auth sweep and the reauth sweep until ctx cancel.
8. **Desktop surface:** `ReauthenticationDialog` — a Radix Dialog owned by the
   `authentication` feature. Callers pass a typed `ReauthAction` from the
   closed set (TS union + client runtime guard), `serverUrl`, an
   `acquireSession` token getter, and receive the issued proof through
   `onProof`. The dialog never exposes session/identity internals; errors map
   to stable codes with i18n; keyboard flow via native form + Radix focus
   trap. `PasswordInput` moves to its own file for reuse (behavior unchanged).

## Test plan (QA map to the 8 criteria)

- C1 active-Admin-only: integration — member 403, no session 401, disabled
  admin 401, wrong password 401 invalid_credentials, active admin 200.
- C2 entropy/hash/5-min: package-local real-DB — hash≠token stored, sha256
  matches, expires_at = issued+5 min; integration asserts response expiry.
- C3 closed action + expiry + consumed + concurrent fail closed:
  package-local real-DB concurrency (N goroutines, exactly one consume wins)
  + integration HTTP codes for wrong action/expired/consumed.
- C4 atomic single transition, no restore after downstream failure:
  package-local real-DB — consumption commits; subsequent failure leaves
  consumed_at set; second consume 409 already_consumed.
- C5 secure transport: integration — both endpoints 400
  secure_transport_required without the proxy marker; succeed with it.
- C6 desktop surface: component test — keyboard-only flow, declared action
  only, wrong-password error, proof delivered via callback; client unit test
  guards undeclared actions (never sends).
- C7 stable contract codes: identity.yaml documents both operations;
  integration responses asserted through the contract-conformance helper.
- C8 coverage + no pre-built actions: suites above; closed set asserted
  (DB CHECK rejects other actions; client rejects undeclared action).

Checks: `go build ./... && go test ./...` (server), full
`./scripts/test-identity-integration.sh` (zero skips), desktop `typecheck`,
`test:unit`, `test:component`, `lint`, `verify:architecture`; PR CI gate.
