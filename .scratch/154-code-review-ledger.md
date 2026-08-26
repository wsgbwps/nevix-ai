# Code review ledger — issue #154 (exact-action Reauthentication Proof)

schema: code-review-findings/v1
fixedPoint: 1713e05e5a80396795ea90093188d6ccb07d734b (origin/main)
scopePaths: server/internal/identity/reauth/**, server/internal/identity/{module,routes,mount_test}.go,
  server/internal/identity/auth/commands.go, server/internal/auditlog/log.go,
  server/internal/auditlog/harness_test.go, server/internal/identity/integrationtest/**,
  server/internal/identity/session/session_integration_test.go, server/internal/migration/**,
  contracts/{identity,openapi}.yaml, deploy/nginx/nginx.conf, scripts/test-identity-integration.sh,
  apps/desktop/src/renderer/src/features/authentication/**,
  apps/desktop/tests/unit/reauth-client.test.mts, apps/desktop/tests/component/**
currentDiffDigest: sha256:c8f7526f6706f708d4718cfddbc5d9dfbba7016f0f6aaa2009b4806fbb1b8d6c
fullReviewCount: 1
targetedReviewRound: 0
relevantCheck: null
outcome: needs-disposition

## Findings

### CR-STANDARDS-0001 — blocker — open — pending
- owner: apps/desktop/src/renderer/src/features/user-management
- source: Desktop CONTEXT.md localized-surface contract; ADR-0009 audit-action evolution
- anchor: server/internal/auditlog/log.go::ReauthProofIssued/ReauthProofConsumed → apps/desktop/src/renderer/src/features/user-management/ui/audit-log-settings.tsx::AUDIT_ACTION_KEYS
- defect: the two new audit actions reach the Admin Audit Log list and CSV export but are absent from AUDIT_ACTION_KEYS and both translations, so the UI exposes raw machine codes
- level: blocker (public-contract presentation breakage)
- evidence: audit-log-settings.tsx lines 42–63 enumerate 13 actions without reauth entries; i18n/resources.ts actions maps lack both keys; line 155 feeds CSV export through the same map
- disposition: accepted — the new audit rows are part of this slice's delivered surface

### CR-STANDARDS-0002 — blocker — open — pending
- owner: apps/desktop/src/renderer/src/features/authentication/api
- source: contracts/identity.yaml issuance success body (required action); trusted-parse discipline
- anchor: apps/desktop/src/renderer/src/features/authentication/api/reauth.ts::parseIssuedProof
- defect: the required response `action` field is discarded and replaced by the request argument, so a malformed or mismatched 200 body is accepted and mislabeled
- level: blocker (public-contract validation gap)
- evidence: parseIssuedProof validates proof+expiresAt only and hard-codes action from the argument
- disposition: accepted — parse and require equality with the requested declared action

### CR-STANDARDS-0003 — blocker — open — pending
- owner: apps/desktop/src/renderer/src/features/authentication/index.ts
- source: apps/desktop/AGENTS.md public-index rule (external consumers import only the index)
- anchor: features/authentication/index.ts reauth exports; tests/component/fixtures/reauthentication-dialog.story.tsx import of type ReauthIssueResult
- defect: the public index omits ReauthIssueResult while a consumer imports it through the seam (typecheck blind spot: tests/component is outside tsconfig.web)
- level: blocker (public-seam contract gap)
- evidence: index.ts exports ReauthAction/ReauthProofRequester/IssuedReauthProof/IdentityApiFailure but not ReauthIssueResult; the story imports it from the feature index
- disposition: accepted — add the named type export

### CR-STANDARDS-0004 — advisory — closed — false-positive
- owner: server/internal/identity/reauth
- source: server/AGENTS.md test-support placement
- anchor: reauth/reauth_integration_test.go::requireEnv/newServiceHarness
- defect (claimed): DB harness helpers embedded in the scenario file instead of a named test-support file
- dispositionReason: server/AGENTS.md's named test-support-file rule governs helpers shared across scenario files (identity/integrationtest/harness_test.go). The session package prior art keeps its single-consumer storeHarness and requireEnv inside session_integration_test.go; reauth's DB helpers have exactly one consumer file. Not a breach.

### CR-STANDARDS-0005 — advisory — closed — deferred
- owner: apps/desktop/src/renderer/src/features/authentication/api
- source: Fowler Duplicated Code
- anchor: api/reauth.ts::createReauthProofRequester vs api/client.ts::request
- defect: fetch/redirect/JSON/error-mapping duplicated within the feature's api segment
- dispositionReason: acknowledged. Per-feature (and per-module) HTTP handling is the established renderer pattern (profile, user-management each own theirs). Consolidating client.ts's login surface is a separate refactor with its own risk; not this slice.

### CR-STANDARDS-0006 — advisory — closed — deferred
- owner: apps/desktop/src/renderer/src/features/authentication/ui
- source: root AGENTS.md code-comments rule
- anchor: ui/reauthentication-dialog.tsx closed-dialog password comment
- defect (claimed): comment says a closed dialog never retains the password; a parent-forced close without callbacks retains it until reopen
- dispositionReason: acknowledged nit. Every surface-controlled close path (success, cancel) clears the password first; only a parent force-close while submitting bypasses it, and the reopen reset clears it. Address with the comment's next revision; not acceptance-blocking.

### CR-SPEC-0001 — blocker — open — pending
- owner: server/internal/identity/reauth
- source: criterion 1 (只有 active Admin 可用当前密码签发 Proof)
- anchor: server/internal/identity/reauth/reauth.go::Service.Issue
- defect: password/status verified outside the issuance transaction; a concurrent password reset or disable that commits in between still yields a proof issued from stale authorization facts
- level: blocker (acceptance criterion violated in the race)
- evidence: ReverifyCurrentPassword reads without lock; Issue inserts without a lock-point recheck, unlike session issuance prior art (session.Issue CredentialStamp + status recheck under FOR UPDATE)
- disposition: accepted — recheck status and the verified credential stamp under the users row lock inside the issuance transaction

### CR-SPEC-0002 — blocker — open — pending
- owner: apps/desktop/src/renderer/src/features/authentication/index.ts
- source: criterion 8 (Desktop component 测试覆盖…可访问键盘流程)
- anchor: index.ts exports; reauthentication-dialog.story.tsx import
- defect: missing ReauthIssueResult export breaks the public seam the component evidence mounts through
- level: blocker (same defect as CR-STANDARDS-0003; one repair closes both)
- disposition: accepted

### CR-SPEC-0003 — advisory — closed — deferred
- owner: apps/desktop/src/renderer/src/features/authentication/api
- source: criterion 7 (公开 contract 定义稳定成功…)
- anchor: api/reauth.ts::parseIssuedProof
- defect: required success action silently dropped (duplicate of CR-STANDARDS-0002)
- dispositionReason: the spec-axis record of the same defect; repaired together with accepted blocker CR-STANDARDS-0002 in this loop. Recorded deferred because this axis's level is advisory.

## Repair records

(none yet)
