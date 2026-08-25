# #142 — Instance Claim 与 Join Code 注册切换到 Session 签发

Parent spec: #138 (Session responsibility module). Blocked-by #140 already merged on
`identity-session-cutover` (`4e378c3`). All work stays on that integration branch.

## Boundary

- Fixed point: `4e378c3` (tip of `identity-session-cutover`).
- Primary Domain: Server Identity. Session responsibility module is the narrowest owner
  of issuance; the two command callers keep command rules, locks, audit semantics.
- Task-owned paths (frozen for review):
  - `server/internal/identity/auth/setup.go`
  - `server/internal/identity/auth/register.go`
  - `server/internal/identity/integrationtest/instance_claim_test.go`
  - `server/internal/identity/integrationtest/register_test.go`
- HTTP/OpenAPI shape, DB schema, business error semantics: unchanged (verified by
  `git diff 4e378c3 -- contracts/ server/internal/migration/` being empty and existing
  contract conformance staying green).

## Change

Both callers currently do, inside their own `runner.Run` transaction: user INSERT →
`UPDATE users SET last_login_at` → inline `INSERT INTO sessions` (token pre-generated
before the transaction) → audit write. Switch both to `s.sessions.Issue(ctx, sc, …)`
inside the same callback, exactly like the #140 Login tracer:

1. Delete the pre-transaction `session.NewToken()` call and the inline session INSERT +
   last_login UPDATE SQL in both files.
2. `Initialize`: after the admin insert, call
   `s.sessions.Issue(ctx, sc, session.IssueInput{UserID: claimed.ID, CredentialStamp: passwordHash})`
   — the stamp is the credential state this command just created (spec #138: "Instance
   Claim and Join Code registration pass the stamp from the newly created credential
   state inside their existing outer transactions"). `DeviceName` stays "" (the request
   has no device_name; schema default is '').
3. `Register`: same, with `registered.ID` and its just-created `passwordHash`.
4. `ErrInactiveUser` / `ErrStaleCredential` are structurally unreachable here (the row
   was created active with exactly this hash in the same transaction, and Issue's
   `FOR UPDATE` re-check trivially passes); they stay unmapped sentinels → default 500
   if ever fired. No new public error shapes.
5. Audit: unchanged — claim writes only `instance_claimed`, register only
   `user_self_registered` (Issue writes no audit by design).

## Tests (contract level, integrationtest)

Behavior is unchanged by design, so the contract suite is the refactor's safety net:
extend it to pin the invariants this ticket names, run green before and after.

- Rollback atomicity (new, both surfaces): inject a failure at the last transaction
  participant (audit write) via a temporary `audit_logs` trigger owned by the fixture
  credential that raises on `instance_claimed` / `user_self_registered`; assert the
  command fails, and users/sessions/last_login/audit all rolled back; then drop the
  trigger and prove the same command succeeds.
- Audit minimal facts: success paths assert the exact audit action list — claim =
  [`instance_claimed`], register = [`user_self_registered`] (no `session_created`).
- Hash-only persistence: stored `token_hash == sha256(response token)` for both
  surfaces (pattern from TestLoginIssuesOpaqueSessionStoredOnlyAsHash).
- Join Code caller-owned locking (new): hold `FOR UPDATE` on the code row from the
  fixture credential; concurrent registration blocks on it; after the holder revokes
  and commits, registration answers `invalid_join_code` with nothing persisted.
- Existing coverage reused: success + immediate usability, concurrent claim first-wins
  (`TestConcurrentClaimIsFirstWins`), email conflict / seats / rate-limit rules.

## Checks

`go build ./... && go vet ./...`; unit `go test ./...`; dedicated identity harness
`./scripts/test-identity-integration.sh` (zero skips); `go test -race ./...`; grep no
residual inline `INSERT INTO public.sessions` outside `session/`.

## Review

`/code-review` initial at fixed point `4e378c3`, pathspec = task-owned paths, spec
source = #142 (+ #138 invariants); repair loop per finding-lifecycle contract.
