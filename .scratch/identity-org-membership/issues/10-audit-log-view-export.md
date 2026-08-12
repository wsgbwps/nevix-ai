# 10 — Desktop 审计日志时间线 + CSV 导出

**What to build:** Organization Audit Log 的查看与导出。采用定稿的 B 时间线：按天分组叙事时间线（"林晓 移除成员 → 李其 · 11:48"式行，直接消费 ADR-0009 写入时快照的 actor/target 显示名）；动作过滤 Select；CSV 导出按钮 + 导出反馈。导出为 Desktop 经 RLS 直读分页 + 本地写文件，不建服务端导出接口。审计入口归入设置页组织组导航，Member 角色不显示（RLS 亦在数据层拒绝）。

**Blocked by:** 04 — Active Organization：状态、设备记忆与启动三分支；06 — Go 邀请命令组 + 审计写入基建 + 携码模板

**Status:** in-review

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
