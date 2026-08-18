# Identity PostgreSQL Execution Identity — Lean V1 Spec

Status: ready-for-agent

本规格把已确认的 Identity PostgreSQL 执行身份讨论收敛为一个适合初版软件的安全切片。它固定安全 invariant、单一事务入口、测试 seam 与明确非目标；它刻意不引入运行期状态机、通用数据库框架或新的进程监督协议。

Authoritative context:

- [Server Identity ubiquitous language](../../server/CONTEXT.md)
- [Complexity-driven DDD layering](../../docs/adr/0003-complexity-driven-ddd-layering.md)
- [Supabase–Go trusted execution seam](../../docs/adr/0004-supabase-go-trusted-execution-seam.md)
- [Outbox relay extraction trigger](../../docs/adr/0006-outbox-relay-extraction-trigger.md)
- [Identity write boundary and RLS grant structure](../../docs/adr/0008-identity-write-boundary-and-rls-grant-structure.md)
- [Audit Log snapshot and immutability](../../docs/adr/0009-audit-log-snapshot-and-immutability.md)

## Problem Statement

Nevix 的 Identity Module 已经使用单一 `identity_app` PostgreSQL role 承载 trusted commands、Verification 和 Outbox Worker，但运行时代码没有形成一个可证明的统一契约。Organization、Membership 和 Invitation 写事务会在事务内执行角色切换；Verification 与 Outbox Worker 则直接从 pool 开始事务。Server 启动时接受任意数据库连接字符串，不验证认证角色或实际参与权限检查的角色；现有 integration harness 还会把 owner credential 同时用于 fixture 管理和生产 Module。

因此，当前安全性依赖部署者正确配置凭据和每个写入口各自记得维护角色约定。新增写路径可能绕过约定；高权限 owner 连接也可能因为能够切换到 `identity_app` 而被错误视为合法运行配置。测试没有直接证明 `session_user`、`current_user` 或五类写事务共享同一个边界。

这是初版软件，解决方案必须只补齐安全 invariant 和责任所有权。它不应借机建设通用 transaction framework、复杂 lifecycle supervisor、运行期 ACL 审计或新的 Outbox 协议。

## Solution

在 Server Identity Domain 内增加一个 Identity-local Write Transaction Module，作为全部 Identity-owned 写事务的唯一生产入口。运行数据库连接必须直接认证为 `identity_app`；角色切换不能把 owner、migration role 或其他高权限连接变成合法应用凭据。

Identity Module 在构造期间真实访问 PostgreSQL，并在返回可用 Module 前证明 `session_user` 与 `current_user` 都精确等于 `identity_app`。每个写事务开始后、业务 callback 执行前再次验证同一 invariant。验证失败立即回滚且不执行业务 callback。

Write Transaction Module 统一负责事务开始、身份验证、commit 与 rollback。Lean V1 callback 沿用 `pgx.Tx` 和 `error`：callback 返回 `nil` 才 commit，返回错误、发生取消或 panic 时 rollback。通用层不自动重试。Organization、Membership、Invitation、Verification 和 Outbox Worker 改为使用同一入口，同时保持现有业务、HTTP contract、Outbox 投递与进程生命周期不变。

测试 harness 分离 owner fixture pool 与 `identity_app` runtime pool。真实 PostgreSQL integration coverage 证明错误身份被拒绝、正确身份被接受、事务契约成立，并让五类现有写路径继续通过同一 runtime credential。

## User Stories

1. As a User issuing an Identity command, I want the command to execute only under the least-privilege Identity database role, so that a deployment mistake cannot silently run my operation with owner privileges.
2. As a User creating an Organization, I want its state, Audit Log, and Outbox writes to share one verified transaction identity, so that the operation remains atomic and least-privileged.
3. As an Organization Member leaving an Organization, I want the Membership write transaction to fail closed when the database identity is wrong, so that authorization-sensitive state is never changed under an unexpected role.
4. As an Owner or Admin managing Invitations, I want Invitation state and notification writes to use the same verified execution identity, so that one path cannot bypass the Identity security boundary.
5. As a User requesting a verification code, I want Verification writes to receive the same execution-identity protection as other trusted commands, so that this previously uncovered path is not privileged by accident.
6. As an email recipient, I want the Outbox Worker to update delivery state only inside a verified Identity transaction, so that background work follows the same database security contract as synchronous commands.
7. As a User whose request encounters an identity mismatch, I want the operation to write nothing, so that a security failure never produces partial state.
8. As a User whose request fails internally, I want the public error to omit database role details, so that infrastructure identities are not exposed through the API.
9. As a deployer, I want Server startup to reject an owner or migration credential, so that a broadly privileged database URL cannot become an accepted runtime configuration.
10. As a deployer, I want an owner connection to remain invalid even when it can execute `SET ROLE identity_app`, so that authentication identity cannot be replaced by an in-transaction downgrade convention.
11. As a deployer, I want Server startup to reject a database connection whose `session_user` is not `identity_app`, so that the authenticated principal is explicit and verifiable.
12. As a deployer, I want Server startup to reject a connection whose `current_user` is not `identity_app`, so that the role actually used for permission checks is explicit and verifiable.
13. As a deployer, I want database unavailability during Identity Module construction to fail startup, so that the process does not advertise a Module whose security prerequisite was never checked.
14. As an operator, I want identity mismatches logged internally with enough expected-versus-observed context to diagnose configuration, so that public redaction does not remove operational visibility.
15. As an operator, I want runtime identity mismatches to fail only the affected operation in Lean V1, so that the initial implementation does not introduce an unproven terminal-state or process-restart protocol.
16. As a Server maintainer, I want one Identity-local owner for `Begin`, identity checks, commit, and rollback, so that the invariant is not duplicated across command and worker packages.
17. As a Server maintainer, I want future Identity write paths to consume the same Write Transaction Module, so that Verification-, Worker-, or retention-style work cannot create a new transaction convention.
18. As a Server maintainer, I want the Write Transaction Module to stay local to Identity, so that a single-Domain need does not create a speculative Server-wide database abstraction.
19. As a Server maintainer, I want callback success to mean commit and callback failure to mean rollback, so that transaction behavior stays small and familiar in the initial version.
20. As a Server maintainer, I want context cancellation before the callback completes to prevent commit, so that abandoned operations do not become successful writes unexpectedly.
21. As a Server maintainer, I want panic paths to attempt rollback and preserve the panic, so that transaction cleanup does not hide programming faults.
22. As a Server maintainer, I want commit failures returned as failures, so that callback completion is not confused with durable transaction success.
23. As a Server maintainer, I want rollback failures retained as secondary diagnostics, so that the original business or infrastructure failure remains intelligible.
24. As a Server maintainer, I want the generic transaction boundary never to replay callbacks automatically, so that SMTP and other non-transactional side effects cannot be duplicated invisibly.
25. As an Outbox maintainer, I want the existing SMTP, retry, claim, commit, and rollback behavior preserved, so that execution-identity hardening does not redesign the relay protocol.
26. As an API maintainer, I want existing trusted-command routes and response contracts preserved, so that this internal security change does not require Desktop changes.
27. As a database security reviewer, I want application identity and role privileges tested as separate invariants, so that the correct role name cannot conceal accidental superuser or `BYPASSRLS` privileges.
28. As a database security reviewer, I want migrations to remain authoritative for role attributes, memberships, and grants, so that the Go Module does not duplicate PostgreSQL's authorization model.
29. As an integration-test author, I want owner credentials used only for fixture setup and assertions, so that production Module tests do not pass merely because the harness is overprivileged.
30. As an integration-test author, I want the runtime pool to authenticate directly as `identity_app`, so that tests exercise the same identity contract expected in production.
31. As an integration-test author, I want startup acceptance and rejection tested against real PostgreSQL roles, so that mocks are not the sole evidence for `session_user` and `current_user` semantics.
32. As an integration-test author, I want Organization, Membership, Invitation, Verification, and Worker paths to continue succeeding through the runtime pool, so that every distinct write category is covered.
33. As a maintainer of an early-stage product, I want this slice to avoid capability graphs, generic result protocols, source scanners, and lifecycle state machines, so that the security improvement remains proportionate to present complexity.
34. As a future maintainer, I want the deferred hardening choices recorded as explicit non-goals, so that evidence—not speculation—determines whether Lean V1 later needs a deeper interface.

## Implementation Decisions

- **Primary Domain and owner:** Server Identity is the primary Domain. A responsibility-named Write Transaction Module inside Identity owns the PostgreSQL execution-identity check and write-transaction lifecycle. The responsibility is not promoted to a shared Server database layer.
- **Canonical execution vocabulary:** the Identity PostgreSQL authentication identity is observed through `session_user`; the Identity PostgreSQL execution identity is observed through `current_user`. Both must exactly equal the fixed role `identity_app`.
- **No role upgrade or downgrade path:** runtime credentials authenticate directly as `identity_app`. A connection authenticated as owner, migration role, superuser, or another role is invalid even if PostgreSQL would allow it to execute `SET ROLE identity_app`. Existing per-command role-switch statements are removed rather than centralized.
- **Coverage boundary:** every Identity-owned database write transaction uses the Write Transaction Module. The initial set comprises Organization commands, Membership commands, Invitation commands, Verification code issuance, and Outbox Worker writes. A future retention sweep must use the same boundary when implemented. Desktop-to-Supabase RLS reads, Profile self-writes, migrations, fixture management, and purely read-only probes are outside this transaction boundary.
- **Pool ownership:** the Identity composition surface supplies the database pool to the Write Transaction Module. Production command, Verification, and Worker components receive the transaction runner rather than retaining the raw pool or calling `Begin` themselves.
- **Fallible construction:** Identity Module construction accepts a startup context and returns an error. It performs a real database round trip before returning a usable Module. Database unavailability or either identity mismatch prevents Module construction and therefore precedes HTTP listener and Worker startup.
- **Per-transaction enforcement:** every runner invocation starts a transaction, checks `session_user` and `current_user`, and invokes the callback only after both match `identity_app`. A mismatch rolls back without invoking business logic.
- **Lean callback contract:** the callback receives the existing `pgx.Tx` and returns an error. `nil` requests commit; a non-nil error requests rollback. Callers treat transaction lifecycle methods as owned by the runner even though Lean V1 does not add a restrictive query-only interface.
- **Cancellation and finalization:** the callback uses the caller's context. Cancellation observed before callback completion prevents commit. Once a successful callback reaches the commit decision while the context is valid, finalization uses a cleanup context so a late cancellation does not turn a decided commit into an avoidable unknown result.
- **Panic and finalization errors:** panic triggers best-effort rollback and remains a panic. Commit errors are returned. Rollback errors remain secondary to the triggering callback, cancellation, identity, or panic failure.
- **No generic retries:** the Write Transaction Module executes a callback at most once. Serialization, deadlock, connection, or other retry policies remain explicit responsibilities of use cases that can prove idempotency. The transaction layer never replays SMTP-bearing work.
- **Outbox compatibility:** the Worker retains its existing claim, SMTP send, retry-state update, commit, rollback, and shutdown behavior. Where delivery reporting must survive a committed transaction, the caller keeps that result outside the callback rather than introducing an Outcome protocol.
- **Runtime mismatch behavior:** an identity mismatch is distinguishable internally and redacted externally. The affected transaction fails closed and writes nothing. Lean V1 does not add a terminal Module state, fatal channel, background supervisor, readiness transition, automatic pool rebuild, or process exit policy.
- **Role-permission responsibility:** the runtime Module proves identity only. Existing migrations remain authoritative for `identity_app` role attributes, memberships, schema privileges, table grants, and RLS interactions. Database security tests prove that the role remains login-capable, non-superuser, without `BYPASSRLS`, role/database creation, or replication privileges, and limited to the intended Identity grants.
- **No schema or public contract change:** no new table, column, policy, database role, public HTTP route, trusted-command payload, or Desktop IPC contract is introduced. The internal Module constructor and component dependencies change only as needed to establish the boundary.
- **Documentation:** the existing Identity write/RLS architecture decision is amended to record runtime ownership and the direct-login invariant. The Server Identity context records the clarified authentication-identity, execution-identity, and composed least-privilege vocabulary. A new ADR is unnecessary because the Supabase-to-Go trusted-execution seam and Domain ownership remain unchanged.

## Testing Decisions

A good test observes the security or transaction contract from the highest practical seam: whether Module construction succeeds, whether a callback or write occurs, whether a transaction commits or rolls back, and whether an existing Identity operation still produces its authoritative database/HTTP/Outbox result. Tests do not lock in private helper names, SQL formatting, log formatting, constructor wiring order, goroutine details, or a hypothetical future restrictive transaction interface.

Two complementary seams are sufficient for Lean V1:

1. **Write Transaction Module contract seam**
   - Use real PostgreSQL roles to prove that an owner/admin connection is rejected even when it can assume `identity_app`, while a connection authenticated directly as `identity_app` is accepted.
   - Prove that both `session_user` and `current_user` are checked.
   - Prove that a transaction-time mismatch prevents callback execution and produces no write.
   - Prove callback `nil` commits; callback error and context cancellation roll back; panic performs best-effort rollback and propagates; commit errors remain failures.
   - Use a narrow test double only where deterministic commit/rollback failure injection cannot be expressed reliably against PostgreSQL. Real PostgreSQL remains the evidence for role semantics.

2. **Existing Identity integration seam**
   - Split the harness into an owner fixture pool and an `identity_app` runtime pool. The owner pool may apply fixtures and inspect authoritative state; it is never supplied to Identity Module production construction.
   - Provision an ephemeral runtime credential for `identity_app` in the local/CI PostgreSQL stack without changing the production role contract.
   - Exercise the existing trusted-command/HTTP and Worker surfaces so Organization, Membership, Invitation, Verification, and Outbox writes continue to succeed through the runtime pool.
   - Confirm command dispatch still reaches existing handlers and that identity failures remain generic at the public boundary.
   - Retain existing database assertions for atomic state, Audit Log, Outbox rows, Verification behavior, and Mailpit delivery instead of introducing a test-only trigger that records `current_user`.

Database role-contract coverage also verifies the role-permission invariant independently of runtime identity: `identity_app` must remain non-superuser, without `BYPASSRLS` or administrative role attributes, and limited to the grants documented by the Identity write/RLS decision.

Prior art is the current Identity integration harness and its Organization creation, Membership, Invitation, Verification-code issuance, Outbox walking-skeleton/retry, contract-conformance, and RLS tests against the version-pinned local Supabase/PostgreSQL stack. The implementation extends these seams rather than creating a new test framework. No source-scanning architecture guard is added in Lean V1.

## Out of Scope

- A Server-wide transaction abstraction or shared database execution package.
- A query-only SQL capability, Unit of Work graph, repository capability graph, generic callback result, or explicit Outcome protocol.
- Compile-time prevention of callback access to `pgx.Tx` lifecycle methods.
- Automatic callback retry for serialization, deadlock, connection, or other failures.
- Runtime enumeration or reconciliation of PostgreSQL ACLs, grants, memberships, or role attributes.
- Runtime credential rotation, pool rebuilding, self-healing, or fallback to a broader database role.
- A terminal Identity state, fatal-error channel, `Module.Run` lifecycle, readiness transition, process supervisor, or non-zero exit policy for post-startup identity drift.
- Source-code scanning or a repository-wide architecture verifier for pool ownership.
- Changes to Outbox claiming, SMTP delivery, retry timing, terminal delivery states, retention, or worker deployment topology.
- Changes to transaction isolation, advisory-lock policy, Audit Log semantics, Verification policy, or trusted-command authorization.
- New database schemas, roles, grants, RLS policies, migrations, public HTTP contracts, Desktop IPC contracts, or UI behavior.
- Implementing the future retention sweep; the spec only binds its eventual write transaction to the same runner.
- Production secret provisioning, Supabase dashboard work, or infrastructure cutover beyond documenting that the runtime connection must authenticate as `identity_app`.
- General cleanup or refactoring unrelated to the five current Identity write categories.

## Further Notes

- This is a high-risk authentication/security-boundary change. Before production code changes, create the repository-required short written plan, state the acceptance boundary, and update the existing architecture/context documentation that owns the invariant.
- The applicable independent Go security review is required before landing. Final-state evidence must bind the accepted base, final diff, relevant Server/Identity checks, coverage, and review conclusion after the last edit.
- The primary Domain is Server Identity. Expected supporting impact is limited to Identity composition, the Server composition root needed to handle fallible Module construction, the local/CI integration harness, and architecture documentation.
- Lean V1 supersedes the earlier, heavier discussion choices for a restricted SQL capability, Outcome protocol, four-layer/source-scan test framework, terminal fault state, fatal signal, `Module.Run`, and process-wide shutdown orchestration.
- A later deepening requires evidence such as a real transaction-boundary bypass, a second execution role, recurring runtime identity drift, or a concrete need for cross-Domain reuse. None is assumed in this spec.
