# Issue #101 — 自助与首登改密 implementation plan

## Boundary declaration

- **Spec source**: issue #99 (用户系统迁移), task issue #101 (2/7).
- **Fixed point**: `main` @ `e51ea59`.
- **Primary Domain**: Server identity Module (`server/internal/identity`).
- **Shared areas touched**: `server/internal/authz` (Principal field),
  `contracts/` (two new endpoints), `scripts/test-identity-integration.sh`
  (sentinels).
- **Task-owned paths**:
  - `server/internal/authz/authz.go` — `Principal.MustChangePassword`
  - `server/internal/identity/command/command.go` — `PasswordGatePolicy` route attribute + gate middleware
  - `server/internal/identity/auth/account.go` (new) — ChangePassword + UpdateMe commands
  - `server/internal/identity/auth/sessions.go` — Authenticate resolves the flag
  - `server/internal/identity/routes.go` — 2 new routes + gate exemptions
  - `server/internal/identity/audit/log.go` — `password_changed` action
  - tests: `command/command_test.go`, `mount_test.go`,
    `integrationtest/password_self_service_test.go` (new),
    `integrationtest/transport_support_test.go`
  - `contracts/identity.yaml`, `contracts/openapi.yaml`

## Design decisions

1. **Endpoints**
   - `POST /identity/auth/change-password` — body `{current_password,
     new_password}`; verifies current password (mismatch → 401
     `invalid_credentials`), enforces min length on the new password (400
     `invalid_password`), in ONE write transaction: update hash + clear
     `must_change_password` + revoke all OTHER sessions + audit
     `password_changed`. **Current session survives** (spec story 6: only
     other devices are invalidated; forced-change flow continues on it).
     This is the current-session disposition the OpenAPI contract defines.
   - `PATCH /identity/users/me` — body `{display_name}`; trims, 1–128 chars
     (400 `invalid_display_name`); returns the updated user (same shape as
     GET /me). No audit row: display-name change is profile data, not a
     governance/security event (#102 owns governance audit coverage).
2. **must_change_password gate** — declarative route attribute
   (`Route.PasswordGate`, zero value = enforce). Mount wraps guarded routes
   with a gate middleware that answers 403 `password_change_required` when
   the principal's account still owes the forced change. Blocked-by-default
   is the safe direction for future business routes. Exempt (auth-scoped):
   login (public), logout, GET /me, change-password. The gate lives in the
   identity command skeleton, NOT in `authz` — ADR-0015 freezes the
   authorization vocabulary at exactly two route guards; this is account
   hygiene, not role authorization.
3. **Principal.MustChangePassword** — resolved per-request by Authenticate
   (query already joins users), so a cleared flag takes effect immediately.
4. **Spec-minimal**: no same-password rejection (policy is min length only);
   no rate limit on current-password failures (session already
   authenticated). Password-change audit metadata marks `initial=true` when
   the change cleared a pending flag.
5. **Sessions**: revocation is `DELETE FROM sessions WHERE user_id = $1 AND
   token_hash <> $2` inside the change transaction.

## Verification

- Seam A integration tests (new `password_self_service_test.go`) cover all
  five ACs; every observed response asserted against the OpenAPI contract
  (drift defense). Sentinels added to the harness script.
- Unit: command Mount gate policy; mount_test Allow-Methods/guard surface.
- Runs: `go test ./...` (unit), `./scripts/test-identity-integration.sh`
  (Seam A), `go vet`, desktop untouched.
