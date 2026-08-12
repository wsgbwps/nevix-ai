# 10 — Desktop 审计日志时间线 + CSV 导出

**What to build:** Organization Audit Log 的查看与导出。采用定稿的 B 时间线：按天分组叙事时间线（"林晓 移除成员 → 李其 · 11:48"式行，直接消费 ADR-0009 写入时快照的 actor/target 显示名）；动作过滤 Select；CSV 导出按钮 + 导出反馈。导出为 Desktop 经 RLS 直读分页 + 本地写文件，不建服务端导出接口。审计入口归入设置页组织组导航，Member 角色不显示（RLS 亦在数据层拒绝）。

**Blocked by:** 04 — Active Organization：状态、设备记忆与启动三分支；06 — Go 邀请命令组 + 审计写入基建 + 携码模板

**Status:** resolved

- [x] e2e：Owner/Admin 查看按天分组的叙事时间线，行内容含快照显示名、动作、目标与时间
- [x] e2e：动作过滤 Select 生效
- [x] e2e：CSV 导出写出本地文件并给出反馈，内容与分页直读结果一致
- [x] Member 无审计入口，直读 audit_logs 被 RLS 拒绝
- [x] 全部新 Localized Surface 双语过发布检查；e2e 用例归入既有 tier；走 feature branch + PR

## Comments

- 2026-08-11: Draft PR [#43](https://github.com/wsgbwps/nevix-ai/pull/43) updated for review `4907012608`. All invitation events now prefer the immutable recipient email, the native save filename is bilingual, and the packaged E2E direct-write guard has executable behavior coverage. The action vocabulary, packaged seam, and `(created_at, id)` keyset pagination fixes remain covered. Awaiting PR CI and merge.

  Final-state evidence
  - Acceptance boundary: Invitation recipient email precedence in timeline/CSV, bilingual native save filename, and packaged/unpackaged E2E output policy, without regressing action vocabulary or stable pagination.
  - Final diff: `sha256:a69d3fea66f0df055a1011c9a46e946d6b9902644fb04180d7ee4eb1225ba18c`
  - Relevant check: Desktop Organization Audit Log review closure
  - Check result: PASS
  - Check coverage: Desktop typecheck, lint, 15 unit tests, architecture verification, 6 i18n resource-contract tests, and 13 Smoke E2E tests including the accepted-invitation timeline/CSV behavior.
  - Review conclusion: Reviewed the final Desktop Organization diff and PASS results; the four review requests are covered without changing public seams or regressing action vocabulary, packaged guard, or keyset pagination.
  - Closure: accepted locally; PR remains in review until CI passes and the branch merges.

- 2026-08-12: Draft PR [#43](https://github.com/wsgbwps/nevix-ai/pull/43) latest authorization review fixes are locally accepted. Audit Log navigation no longer changes the top-level renderer URL, so `authentication:clear-session` remains callable; Settings entry refreshes the current Membership under RLS and updates the Active Organization cache, so an Admin demoted to Member loses both Audit Log surfaces without treating an empty Audit Log as an authorization signal. Authentication, platform, RLS, migrations, and Go remain unchanged.

  Validation: Desktop typecheck PASS; lint PASS; unit 15/15 PASS; architecture 30/30 PASS (109 source files); i18n resource contract 6/6 PASS; Smoke E2E 15/15 PASS, including clear-session + logout/restart and runtime Admin→Member behavior.

  Final-state evidence
  - Acceptance boundary: Audit Log navigation must preserve Authentication Session clearing and logout across restart; Settings entry must refresh the current Membership so runtime Admin→Member demotion hides both Audit Log surfaces while RLS remains authoritative.
  - Final diff: `sha256:731ef404c719956789f17f34b4995464bf9e55d3f5f7d9acddb7e0ab4fb2275a`
  - Relevant check: Desktop Organization Audit Log authorization review closure
  - Check result: PASS
  - Check coverage: Audit Log navigation preserves Authentication clear-session and logout across restart; runtime Admin-to-Member refresh hides the Audit Log navigation and section while RLS remains authoritative.
  - Review conclusion: Reviewed the complete final Organization diff and bound Smoke result; navigation no longer mutates the renderer URL, Authentication clear-session remains trusted, and refreshed Membership roles fail closed without inferring authorization from empty Audit Log data. No boundary or unrelated changes found.
  - Closure: accepted locally; PR remains in review pending the latest CI run and merge.

- 2026-08-12: Integrated latest `main` (`615e75b`, PR #44) to clear GitHub's dirty merge state and allow the PR workflow to run. Three Organization conflicts were resolved as behavior unions: invitation acceptance/startup reconciliation remains intact; Audit Log Membership refresh remains intact; E2E helpers retain both invitation/Profile and Audit Log/role fixtures. Audit Log now reuses main's canonical `AuthenticatedOrganizationSession`, and the Member fixture explicitly supplies the Profile required by the latest startup flow.

  Validation after integration: Desktop typecheck PASS; lint PASS; unit 20/20 PASS; architecture 30/30 PASS (111 source files); i18n resource contract 6/6 PASS; latest-main Smoke E2E 18/18 PASS, including clear-session + logout/restart, runtime Admin→Member removal, Member RLS denial, and PR #44 invitation flows.

  Final-state evidence
  - Acceptance boundary: Latest-main invitation/startup behavior and the Audit Log authorization fixes must coexist; clear-session/logout restart, runtime Admin→Member surface removal, and Member RLS denial must remain correct.
  - Final diff: `sha256:1b49e222d05f538ece6f61d634cc26c22b3d6122e73023defbe30537bb8b0eb0`
  - Relevant check: Desktop Organization Audit Log main integration closure
  - Check result: PASS
  - Check coverage: Merged invitation/startup reconciliation with Audit Log Membership refresh; Authentication clear-session/logout restart, runtime Admin-to-Member removal, and Member RLS denial remain correct on latest main.
  - Review conclusion: Reviewed the latest-main conflict union and PASS results; PR #44 invitation/startup behavior and the Audit Log refresh/clear-session fixes are both preserved, the Organization session type is canonical, and Member fixtures now satisfy the Profile prerequisite without weakening RLS coverage.
  - Closure: accepted locally; merge commit remains to be pushed so GitHub can start the latest PR CI gate.

- 2026-08-12: Spec evidence follow-up removes the manual Session clear that previously masked the real user-menu logout path. Audit Log navigation now proves the renderer URL remains fragment-free and the non-destructive Session read IPC remains trusted before a real logout; the same `userData` then restarts unauthenticated. The empty-log Admin scenario now proves both Audit Log surfaces are initially visible, returns to the App Shell, applies the runtime Member demotion, and proves both surfaces disappear on Settings re-entry.

  Validation: the two focused Playwright scenarios PASS (2/2); Desktop typecheck PASS; Desktop lint PASS; the final Desktop Smoke rerun PASS (18/18). The first full Smoke attempt was 17/18 because an unchanged App Shell scenario remained on its startup restoration screen; every Audit Log scenario passed in that attempt, and the clean full rerun closed the check.

  Final-state evidence
  - Acceptance boundary: Audit Log navigation must leave the renderer URL fragment-free and Session IPC trusted; real user-menu logout must clear the persisted Session without a prior manual clear; an Admin with an empty Audit Log must see both Audit Log surfaces before a runtime Member demotion removes them on Settings re-entry.
  - Final diff: `sha256:69305ff6f44cfd6698d2303d5b2779710dffeadc73563865c5784e967e47ebf4` (scoped Organization E2E diff)
  - Relevant check: Desktop Organization Audit Log spec evidence closure
  - Check result: PASS
  - Check coverage: Fragment-free trusted Session IPC, real user-menu logout persistence across restart, and empty-log Admin visibility before runtime Member demotion; final Desktop Smoke 18/18.
  - Review conclusion: The focused E2E diff now observes both requested behaviors without pre-clearing the persisted Session or using empty Audit Log data as an authorization signal; no product implementation or shared boundary changed.
  - Closure: accepted locally; PR remains in review pending this evidence-only fix push and its CI gate.

- 2026-08-12: PR #43 follow-up keeps Membership refresh failures distinct from authorization denial. An Owner/Admin now receives bilingual, retryable feedback while Audit Log controls and rows stay fail closed; a successful retry may render a legitimate empty Audit Log, while a successful Member result still removes both surfaces. Audit Log and Membership reads now share `createOrganizationDataClient` with the canonical `AuthenticatedOrganizationSession`; the duplicate client and `AuthenticatedMembershipSession` alias were removed.

  Validation: Desktop typecheck PASS; lint PASS; unit 20/20 PASS; architecture 30/30 PASS (111 source files); i18n resource contract 6/6 PASS; final Smoke rerun 19/19 PASS. The first Smoke run was 18/19 because the unchanged App Shell scenario remained on its startup restoration screen; all six Audit Log scenarios passed, and the clean full rerun closed the final check.

  Final-state evidence
  - Acceptance boundary: Membership refresh errors remain explicit and retryable without exposing protected Audit Log controls or rows; successful empty Audit Logs and true Members remain distinct; Audit Log reads reuse the Organization Data API client seam.
  - Final diff: `sha256:7ac3ff27536359cf65d0c8f7aa0542c4591a3216db3c0dab1f52305d1e66e99f` (scoped Organization implementation and Smoke diff)
  - Relevant check: Desktop Organization Audit Log review findings closure
  - Check result: PASS
  - Check coverage: Membership refresh failures remain explicit and retryable while Audit Log content stays fail closed; successful empty logs and true Members remain distinct; Audit Log reads reuse the Organization Data API client seam; Desktop Smoke remains green.
  - Review conclusion: Reviewed the complete Organization implementation, Smoke, and ticket diff with the PASS relevant check; membership refresh errors remain retryable and fail closed, empty logs and true Members stay distinct, and the duplicate Data API client/session seam is removed without shared-area or architecture-boundary changes.
  - Closure: accepted locally; commit and PR review-thread closure remain pending.

- 2026-08-12: Final review convergence on code head `312f865` closes the remaining Standards follow-up without reopening accepted behavior. Audit Log access verification and retry orchestration now live in `model/audit-log-access.ts`; Authentication Session IPC and Organization export IPC share the `main/window/`-owned exact top-level renderer predicate documented in Desktop ADR-0003. A complete comparison of all 13 previously resolved threads found no regression. Two later technical comments were withdrawn because they reinterpreted already accepted behavior and placement rather than identifying changes introduced by the final fix.

  Validation: Desktop typecheck PASS; lint PASS; unit 27/27 PASS; architecture 30/30 PASS (112 source files); i18n resource contract 6/6 PASS. GitHub CI gate for code head `312f865` PASS ([run 31565964250](https://github.com/wsgbwps/nevix-ai/actions/runs/31565964250)), including Desktop build and Smoke E2E 19/19.

  Final-state evidence
  - Acceptance boundary: Audit Log access state remains in the Organization model, sensitive Authentication and Organization IPC share one documented window-owned renderer predicate, and all previously accepted Audit Log behavior remains intact.
  - Final diff: `sha256:9ccc77e80ac19bf89359259aabc7c2418ded67fabf5a958bcf4a378dd53e5fd4` (scoped final Standards repair diff)
  - Relevant check: Desktop Organization Audit Log final Standards closure
  - Check result: PASS
  - Check coverage: Audit Log access workflow stays in model; Authentication and Organization sensitive IPC share the exact top-level renderer guard; Desktop typecheck, lint, unit, architecture, and i18n contracts pass.
  - Review conclusion: Reviewed the exact final Standards repair diff and PASS result; Audit Log access orchestration is owned by model, sensitive Authentication and Organization IPC share the documented window-owned renderer predicate, and no direct regression remains in the checked scope.
  - Closure: accepted; final code head `312f865` and its CI are green, review-comment convergence is recorded, and only the documentation-only closure commit remains before merge.
