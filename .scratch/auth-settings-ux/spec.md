# Authentication Usability and Settings Information Architecture Spec

Status: ready-for-agent

本规格把已经封版并由 User 确认共同理解的 [Authentication Usability and Settings Information Architecture 设计](./design.md) 转成两条互不依赖的交付主线；每条主线再按真实依赖拆为可独立验收的垂直 tickets。设计文档仍是交互边界的权威来源；本规格负责固定责任所有者、module interface、测试 seam、交付依赖和回滚边界，不重新访谈或重开已决事项。

Authoritative context:

- [Desktop ubiquitous language](../../apps/desktop/CONTEXT.md)
- [Final authentication policy](../identity-v1/issues/03-finalize-authentication-policy.md)
- [Identity V1 baseline](../identity-v1/spec.md)
- [Organization Membership implementation spec](../identity-org-membership/spec.md)
- [Renderer routing topology](../../apps/desktop/docs/adr/0004-renderer-routing-topology.md)
- [Supabase–Go trusted execution seam](../../docs/adr/0004-supabase-go-trusted-execution-seam.md)
- [Identity write/RLS grant structure](../../docs/adr/0008-identity-write-boundary-and-rls-grant-structure.md)
- [Audit Log snapshot and immutability](../../docs/adr/0009-audit-log-snapshot-and-immutability.md)

## Problem Statement

Nevix 已经具备安全的加密 Session、邮箱密码认证、Profile、Organization Membership 与基础 Settings Page，但当前体验和授权仍有两组明显缺口。

第一，Authentication Domain 只保存 Session，不提供 Remembered Email；登录、注册和恢复表单也缺少完整的桌面编辑体验。User 每次重新认证都要重复输入邮箱，无法临时查看密码，应用失焦时又没有主动遮蔽已显示密码。当前创建密码界面暴露 UTF-8 字节计数，Supabase Auth 的最终 12–72 字节、泄露密码与 Session 时限配置也尚未全部落实。

第二，Settings Page 仍把多个内容块同时挂载在一个长页面中，以 anchor 或滚动定位模拟导航。它不能表达一个独立 Settings Section 的生命周期、来源业务视图、Router Back、Organization 切换、脏表单、进行中写命令、Audit 导出和普通窗口关闭之间的统一规则。现有 Organization 名称编辑还位于 Members 内容中，并允许 Admin 通过界面和 Go trusted command 修改；这与最终的 Organization Details 术语和 Owner-only 授权冲突。

如果只修界面而不修存储、路由状态和 Go 授权，User 仍会遇到草稿丢失、陈旧权限、无法确认写结果或客户端隐藏可被绕过的问题。

## Solution

交付两条互不依赖的垂直主线；每条主线内的 ticket 都在自己的 feature branch 和 PR 中独立构建、测试、合并和按依赖逆序回滚：

1. **Authentication Usability**：以 Authentication Domain 为主 Domain，在现有认证 flow 和加密持久化 interface 上增加单槽 Remembered Email、标准桌面编辑能力、密码显示/隐藏与安全遮蔽，落实最终密码和 Session 配置，同时保持现有加密 Session 默认行为。
2. **Settings Information Architecture and Organization Authorization**：以 Organization Domain 为主 Domain，由 app-owned Settings Page 显式组合 Profile、Language 与 Organization 各 Feature 的 Settings Section；保持唯一顶层 `/settings` route，以 memory-history entry state 和一个导航协调 interface 管理 Section、来源、脏状态和阻塞操作。Organization Details 对全部活跃 Member 可见，但 Desktop 仅 Owner 可编辑；同一切片把 Go trusted command 收紧为 Owner-only，并同步公共 contract 与安全测试。

两条主线不互相 blocking。Settings 主线只依赖已经交付的 Profile、Organization Membership、Audit Log 和 Settings 基础能力；Authentication 主线不改变 Profile、Membership 或 Settings 信息架构。主线内只在一张票真正消费另一张票的产物时建立 blocking edge；机械性 i18n、registry 或 composition wiring 重叠由指定 integration owner 收口。

## User Stories

### Authentication Usability

1. As a returning User, I want the login form to remember my email by default, so that I can sign in without retyping a non-secret identifier.
2. As a security-conscious User, I want Remembered Email to store no password or Session extension, so that convenience does not become a credential.
3. As a User, I want my email to be remembered only after a successful login, so that typos and failed attempts never replace a valid saved value.
4. As a User, I want the saved value to come from Supabase's authoritative User email, so that aliases, casing, or server normalization do not preserve stale input.
5. As a User sharing a device over time, I want the device to keep only the most recently accepted Remembered Email, so that the login page does not become an account list.
6. As a User, I want a different User's successful remembered login to replace the previous value, so that the device resumes with the latest choice.
7. As a User, I want clearing the remember-email checkbox to delete the saved value immediately, so that I can remove it without completing another login.
8. As a User, I want the remember-email checkbox to remain selected by default even when no email is saved, so that the next successful login gets the expected convenience.
9. As a returning User with a Remembered Email, I want the authoritative email prefilled and the password field focused, so that I can continue directly with my secret.
10. As a User without a Remembered Email, I want an empty email field and email focus, so that the form starts at the first missing input.
11. As a User correcting a prefilled email, I want a successful login to replace the old value with the response's authoritative email, so that future launches use the corrected identity.
12. As a User correcting a prefilled email, I want a failed login to keep my typed value on screen, so that I can fix the attempt without starting over.
13. As a User whose corrected login failed, I want the previously saved email to remain unchanged across restart, so that unverified input never becomes device state.
14. As a User, I want signup and password recovery flows not to overwrite Remembered Email, so that only a verified login choice changes it.
15. As a User, I want current-device logout not to clear Remembered Email, so that logging out ends the Session without removing the separate convenience preference.
16. As a User on a device without usable secure storage, I want login to continue with an in-memory remembered value and one non-blocking explanation, so that storage capability does not block authentication.
17. As a User on a device without usable secure storage, I want no plaintext fallback, so that Remembered Email follows the same secure-at-rest posture as other authentication state.
18. As a User whose encrypted remembered record is corrupt, I want the app to delete it and continue with an empty login form, so that corruption never traps me at startup.
19. As a maintainer, I want corrupt remembered records to produce an internal warning without exposing implementation details to the User, so that failures are diagnosable and safe.
20. As a Desktop User, I want standard clipboard keyboard shortcuts in every editable field, so that text editing behaves like a native application.
21. As a Desktop User, I want a right-click edit menu in every editable field, so that undo, cut, copy, paste, delete, and select-all remain discoverable.
22. As a User entering a password or verification code, I want paste to be allowed, so that password managers and copied codes work normally.
23. As a User entering my login password, I want an explicit show/hide control that starts hidden, so that I can verify difficult input when needed.
24. As a User creating an account, I want independent show/hide controls for password and confirmation, so that revealing one field does not reveal the other.
25. As a User setting a recovery password, I want a show/hide control that starts hidden, so that the recovery flow has the same usability.
26. As a User moving to another authentication step, I want every password field to return to hidden, so that revealed state never leaks across flow transitions.
27. As a User whose app window loses focus or is minimized, I want all revealed passwords hidden immediately without clearing their values, so that shoulder-surfing risk is reduced without losing work.
28. As a User creating or recovering a password, I want a persistent recommendation to use at least 12 characters, so that the policy is understandable without exposing byte accounting.
29. As a User logging in, I want no password-creation hint, so that ordinary login stays concise.
30. As a User whose new password is outside the allowed UTF-8 byte range, I want a clear too-short or too-long error without a byte counter, so that the interface stays human-readable.
31. As a User choosing a leaked password during signup or password change, I want Supabase Auth to reject it with actionable localized guidance, so that known compromised secrets are not accepted.
32. As a User during a Have I Been Pwned outage, I want signup or password change to remain available while the failure is logged internally, so that an external checker cannot take down authentication.
33. As a User whose valid legacy password produces a weak-password signal at login, I want ordinary successful login to continue, so that Nevix does not invent a weak-password migration gate before one is needed.
34. As a User with a transient network failure, I want the encrypted Session preserved and retried, so that temporary outages do not sign me out.
35. As a User whose refresh token is explicitly revoked or whose security state requires reauthentication, I want the Session cleared and only Remembered Email restored, so that no password or invalid Session is replayed.
36. As a User, I want inactive Sessions to require login after 14 days and every Session to end after 90 days, so that convenience has bounded lifetime.
37. As a User, I want all new authentication messages and controls in Simplified Chinese and English, so that the Localized Surface remains complete.

### Settings Information Architecture and Organization Authorization

38. As a signed-in User, I want a normal entry into Settings to open Profile, so that the page has a predictable starting point.
39. As a User, I want Settings to present exactly one Settings Section at a time, so that each task has a focused surface and independent lifecycle.
40. As a User, I want Profile and Language grouped under Account, so that personal and device settings are easy to find.
41. As an active Member, I want Organization Details, Members, and permitted Audit Log access grouped under Organization, so that tenant-scoped settings are distinct from account settings.
42. As a User, I want the active Organization name and role visible in Settings chrome, so that I always know which context organization settings affect.
43. As an active Member, I want to view Organization Details, so that I can confirm the Organization name even when I cannot edit it.
44. As an Owner, I want to edit the Organization name in Organization Details, so that final control stays with the Organization's unique Owner.
45. As an Admin, I want Organization Details to be read-only, so that my UI accurately reflects the finalized authorization policy.
46. As a Member, I want Organization Details to be read-only, so that ordinary membership never implies governance authority.
47. As an Owner, I want an Organization name update to be enforced by the Go trusted command, so that success does not depend on client-side visibility checks.
48. As an Admin invoking the Organization settings command directly, I want the existing non-enumerating 403 response, so that the authorization contract remains consistent and cannot be bypassed.
49. As a non-member invoking the Organization settings command, I want the existing non-enumerating not-found behavior, so that Organization existence is not disclosed.
50. As a User editing Profile on multiple devices, I want the last successful write to win, so that V1 remains understandable without conflict UI.
51. As an Owner editing Organization Details on multiple devices, I want the last successful write to win, so that V1 does not invent versions, ETags, or merges.
52. As a User entering Profile or Organization Details, I want authoritative data read again, so that a previously unmounted Section never shows an old draft as current data.
53. As a User whose Profile or Organization Details save fails, I want my local draft retained with a retryable error, so that transient failure does not destroy work.
54. As a User opening Settings from a business view, I want “Back to app” and Router Back to return to that valid source, so that Settings behaves like a temporary full-screen destination.
55. As a User whose recorded source is no longer valid, I want Settings to fall back to Home, so that back navigation never enters an inaccessible view.
56. As a User who changes Organization while in Settings, I want the recorded source revalidated for the new Organization, so that return navigation cannot cross an authorization context incorrectly.
57. As a User selecting a Settings Section, I want the current history entry replaced rather than extended, so that Router Back leaves Settings instead of replaying Section clicks.
58. As a User, I want the active Settings Section and source kept out of the URL, hash, and nested routes, so that the single top-level Settings route remains authoritative.
59. As a User with unsaved Profile changes, I want confirmation before switching Section, leaving Settings, or changing Organization, so that I do not discard work accidentally.
60. As an Owner with unsaved Organization Details changes, I want the same confirmation before navigation, so that organization edits receive identical protection.
61. As a User changing Language Mode, I want it saved immediately without a dirty-form dialog, so that device language remains instant.
62. As a User seeing a discard confirmation, I want only “Continue editing” and “Discard changes,” so that navigation does not secretly start an asynchronous save.
63. As a User whose Membership, role, or Session changes for security reasons, I want the change to take effect without a discard prompt, so that stale drafts cannot delay authorization enforcement.
64. As a User whose Organization Details edit permission is removed, I want the draft discarded and the authoritative value shown read-only, so that revoked authority is reflected immediately.
65. As a User forced out of Settings by a security change, I want drafts discarded with a non-blocking explanation, so that safety wins without leaving the outcome ambiguous.
66. As a User while Profile or Organization Details is saving, I want Section changes, back navigation, and Organization switching disabled, so that one write has a determinate result.
67. As a User closing the window while a form save is running, I want normal close to wait for the result, so that a successful write is not abandoned midway.
68. As a User whose in-flight save fails during close, I want closing cancelled and the draft retained, so that failure remains recoverable.
69. As a User with a dirty form who closes or quits normally, I want the same discard confirmation as in-app navigation, so that window controls do not bypass protection.
70. As a User switching Organization from Settings, I want to remain on the same Settings Section when permitted, so that I can compare the same kind of information.
71. As an Owner or Admin losing Audit Log permission after an Organization switch, I want Settings to fall back to Members, so that no inaccessible Audit Section remains mounted.
72. As a User on Profile or Language, I want Organization switching not to change my Section, so that account-scoped tasks are unaffected by Organization context.
73. As a User entering an Organization Section, I want Membership refreshed first, so that role-dependent controls use current authority.
74. As an Owner or Admin entering Audit Log, I want Membership verified before Audit data is read, so that sensitive content fails closed.
75. As a User after a member or invitation command, I want Membership, Members, and Invitations reread, so that the screen reconciles with authoritative state.
76. As a User whose Membership refresh fails due to network or service error, I want permission shown as unknown rather than revoked, so that uncertainty is not mistaken for a security decision.
77. As a User in a permission-unknown state, I want previously loaded ordinary read-only content retained with a warning, so that transient failure does not erase harmless context.
78. As a User in a permission-unknown state, I want actions requiring a fresh role disabled, so that stale authority cannot authorize a write.
79. As an Owner or Admin whose Audit permission cannot be reverified, I want existing Audit content cleared or withheld, so that sensitive data fails closed.
80. As an authorized User whose Audit data request fails, I want to remain on Audit Log with a retryable error, so that a data failure is not disguised as no events or lost permission.
81. As a User whose successful Membership refresh confirms Audit permission loss, I want Audit content cleared, its navigation hidden, and Settings moved to Members, so that the UI immediately matches authority.
82. As a User opening the Organization picker from Settings, I want the current Active Organization retained until a new choice succeeds, so that cancelling returns to a stable context.
83. As a User cancelling the Organization picker, I want to return to the original Settings Section, so that exploration does not lose my place.
84. As a User whose original Membership ends while the picker is open, I want the normal picker or onboarding path instead of returning to invalid Settings context, so that cancellation cannot restore lost access.
85. As a User creating an Organization or accepting an Invitation from a Settings-origin picker, I want to return to my original Section with permission fallback applied, so that the Settings task continues in the new context.
86. As a User entering the picker from startup, I want successful selection, creation, or Invitation acceptance to continue to Home, so that startup behavior remains unchanged.
87. As a User with a dirty Settings form, I want discard confirmation before opening the picker, so that Organization selection never silently drops a draft.
88. As a User who discarded a draft before opening the picker and then cancels, I want authoritative data reread rather than the draft restored, so that a confirmed discard stays final.
89. As a User entering Members, I want the Members tab selected by default, so that internal tab state is temporary and predictable.
90. As a User switching Organization or re-entering Members, I want internal tab state reset, so that Pending Invitations never becomes Settings history.
91. As a User without invitation-management permission, I want only the Members tab, so that inaccessible Pending Invitations are not advertised.
92. As a User leaving a Settings Section, I want its view and request state released, so that re-entry starts from authoritative data rather than cross-Section cache.
93. As a User restarting after Settings work, I want normal startup and Profile as the next Settings default, so that route, Section, and unsaved drafts are never crash-recovered.
94. As a User while a member or invitation trusted command is pending, I want Settings navigation, Organization switching, back, and normal close blocked, so that a write is not duplicated or abandoned.
95. As a User whose trusted command times out, I want no automatic retry and an authoritative reread, so that an unknown result cannot create a duplicate write.
96. As a User whose post-timeout reread also fails, I want “result not yet confirmed,” the same action disabled, and only “Check again,” so that I cannot repeat a possibly committed command.
97. As a User whose post-timeout reread succeeds, I want the interface to show actual state and permit retry only when safe, so that recovery follows authority rather than assumptions.
98. As a User exporting Audit Log, I want navigation, Organization switching, and normal close blocked while the save dialog or file write is active, so that export has a determinate lifecycle.
99. As a User cancelling the Audit save dialog, I want navigation restored and no file created, so that cancellation has no side effect.
100. As a User, I want all new Settings surfaces, confirmations, errors, and status messages in Simplified Chinese and English, so that the Localized Surface remains complete.

## Implementation Decisions

### Normative delivery decisions

- The finalized design is an input, not an interview draft. If implementation evidence exposes a direct contradiction, stop the affected slice and record the conflict; do not silently replace the decision.
- Authentication Usability and Settings Information Architecture are two independent delivery mainlines. Each mainline is decomposed into dependency-ordered vertical tickets; every ticket lands through its own feature-branch PR, remains independently buildable, testable and mergeable, and can be reverted from a green baseline in reverse dependency order without temporary compatibility aliases.
- Authentication Usability has **Authentication Domain** as its primary Domain. Settings Information Architecture has **Organization Domain** as its primary Domain; app-level Settings composition, Profile and Language contributions, the Server Identity Module, and the public identity contract are narrowly scoped supporting changes.
- Tickets that touch authentication, authorization, a security boundary or the public contract require a short written implementation plan in the local tracker before their product-code changes begin. The Owner-only Organization Details authorization ticket must bind the Desktop affordance, Go trusted command and public contract in the same PR.
- No source move is planned. Every new source must use the narrowest owner listed below; a need to place it elsewhere is an architecture conflict, not permission to create a new convention.

### Responsibility and interface ownership

| Responsibility | Narrowest owner |
| --- | --- |
| Login/signup/recovery flow state, Remembered Email UI policy, focus, password visibility, localized Auth error mapping | Renderer Authentication Feature |
| Encrypted Remembered Email single-slot storage and corruption handling | Main Authentication Domain |
| Remembered Email cross-process read/replace/clear declarations and handlers | Authentication Domain's existing typed IPC interface and adapter |
| Standard editable-field context menu and desktop edit accelerators | Existing Window platform owner; no Authentication business logic in the composition root |
| Password, HIBP, access-token and Session timeout configuration | Supabase Auth deployment and pinned local/CI stack configuration |
| Settings Section selection, source entry, navigation intent, dirty confirmation and close coordination | app-owned Settings Page aggregation; this is composition behavior, not a Settings Domain |
| Profile authoritative read/write and form lifecycle | Profile Feature |
| Language Mode immediate persistence | Language Feature |
| Organization context, Organization Details, Members, Invitations, Audit Log, permission verification and Settings-origin picker behavior | Organization Feature |
| Owner-only Organization name write, immutable Audit Log transaction and error semantics | Existing Server Identity Module's Organization responsibility |
| Public description of the Organization settings command | Existing identity OpenAPI contract |
| Ordinary renderer close interception needed by the active Settings lifecycle | Existing Window platform lifecycle plus the app Settings coordinator; no business rule in Main composition wiring |

### Authentication Usability module decisions

- Remembered Email is a separate Authentication Domain record, not a field in the persisted Session envelope and not Profile data. It contains one authoritative email string and never contains a password, token, user list, display name, or Organization state.
- The Main Authentication Domain exposes one small store interface with read, replace, and clear behavior. Read outcomes distinguish a usable email, empty storage, unavailable secure storage, and unreadable data. Replace distinguishes encrypted persistence from in-memory-only fallback. The renderer and tests cross the same typed IPC seam.
- Reuse the existing encrypted-envelope and atomic-replace principles internally, but do not generalize a cross-Domain encrypted-store abstraction for one new caller. Remembered Email has its own record, size limits, envelope version and lifecycle so Session deletion and logout cannot remove it accidentally.
- `safeStorage` is mandatory for persistence. Linux `basic_text`, an unavailable backend, encryption failure, or filesystem failure must not create plaintext. The current process may retain the value in memory; one non-blocking Localized Surface notice is shown per process when persistence is unavailable.
- An unreadable or invalid encrypted remembered record is deleted, treated as empty, and logged as an internal warning. It does not become a blocking restore-failure surface because Remembered Email is optional convenience rather than Session authority.
- Authentication initialization reads Remembered Email alongside the existing Session restoration work. The login form chooses initial focus only after the remembered-email outcome is known, preventing focus from jumping after render.
- The checkbox is selected by default. Unchecking clears both the encrypted record and any in-memory fallback immediately. Rechecking merely opts the next successful login into saving; it does not persist unverified input.
- Only a successful password login may replace Remembered Email, and it uses the email on Supabase's returned User. Failed login preserves both the current typed field and the previous saved record. Signup verification, recovery verification, password recovery completion, Session restore, and logout never replace or clear Remembered Email.
- Remembered Email persistence is non-blocking relative to successful authentication. A storage failure cannot turn valid credentials into a failed login or prevent entry into the authenticated app.
- Password visibility is separate local UI state for login password, signup password, signup confirmation, and recovery new password. Every field begins hidden; leaving its authentication flow step resets it. A renderer window blur or document visibility loss hides every revealed password without clearing input.
- Password and one-time-code fields accept paste. The Window platform owner provides standard native editing roles only for editable renderer targets; no general browser menu, navigation command, developer tool entry, or Domain-specific menu is added.
- Password input remains an opaque UTF-8 byte string: no trim, case conversion, or Unicode normalization. Signup and password update accept 12–72 UTF-8 bytes. The UI shows the stable “12 or more characters” recommendation and only localized too-short/too-long failures, never a live byte count.
- Supabase Auth is the authoritative password-policy enforcement. Before the first real User, every production-equivalent environment is configured for minimum 12 bytes, no mandatory character-class composition, HIBP leaked-password rejection with fail-open behavior, one-hour access tokens, refresh-token rotation with the existing reuse interval, 14-day inactivity timeout, and 90-day absolute time-box.
- Map Supabase `weak_password` failures for password creation/change into actionable localized length or leaked-password errors. Preserve existing `same_password` behavior. Unknown Auth errors remain a safe retryable service error and enter internal telemetry.
- A successful `signInWithPassword` Session is always an ordinary login even if the response contains `weak_password`; the renderer does not create a `weakPassword` state, route, modal, or login gate. HIBP remains authoritative only when creating or changing a password.
- Preserve the existing encrypted Session interface and offline behavior. Network, timeout and temporary provider failures retain the encrypted Session; explicit refresh-token revocation, password security events, logout, or strong User security state clear it and return to login with at most Remembered Email prefilled.
- No product business logic is added to Main composition wiring or generic preload. The preload remains typed `invoke`/`on`; Authentication owns any new Channel declarations and handlers.

### Settings Page state and navigation decisions

- Keep exactly one top-level `/settings` route. Profile, Language, Organization Details, Members, and Audit Log are Settings Section values, not routes, nested routes, URL fragments, hashes, or anchors.
- The Settings route stays thin. The app-owned Settings Page explicitly assembles Feature exports and renders one active contribution; it does not create a dynamic plugin registry or a Feature/Domain named `settings`.
- A normal transition from a business view creates one Settings history entry whose memory-only state contains the active Section and a validated source descriptor. The default Section is Profile. Selecting another Section replaces that same entry.
- Router Back and “Back to app” submit the same navigation intent to one Settings coordinator. If the source entry still exists and remains enterable under the active Session and Organization, navigation returns there; otherwise it replaces Settings with Home.
- Revalidate the source after Organization change. A source tied to a different or newly inaccessible Organization is invalid and falls back to Home rather than being replayed.
- The Settings coordinator is the single interface for Section switch, back, leaving Settings, Organization switch, picker entry and ordinary close. The active Feature contribution reports only its externally relevant lifecycle: clean, dirty, saving, command pending, unknown command result, or Audit export active; a dirty contribution also exposes discard behavior. Feature business state remains inside its owner.
- User-initiated navigation from dirty Profile or Organization Details opens one discard confirmation with only continue-editing and discard actions. Discard never starts a save. Language is always clean because Language Mode persists immediately.
- Saving blocks all in-app navigation intents and Organization switching. An ordinary window close records a pending close intent and waits: clean completion continues closing; failure cancels closing, leaves Settings mounted, retains the draft, and shows the retryable form error. System-forced termination remains outside the guarantee.
- Confirmed Membership loss, role reduction, Session end, or another forced security transition bypasses dirty confirmation. It clears affected drafts, restores authoritative read-only data where still permitted, or leaves Settings immediately; a non-blocking explanation describes the forced change.
- Unmount the old Settings Section after a successful switch and release its request/UI state. Re-entering Profile, Organization Details, Members, or Audit Log performs a new authoritative read. Language's already-persisted device state is the only exception. No cross-Section data cache is introduced.
- Normal close, restart, or crash recovery never restores `/settings`, the active Settings Section, source entry, internal Members tab, operation state, or unsaved draft. Session restoration follows normal startup; the next normal Settings entry opens Profile.

### Feature contribution decisions

- Profile remains owned by the Profile Feature. Its form reports dirty/saving state to the Settings coordinator, uses last-successful-write-wins, rereads on mount, retains draft on save failure, and discards only through its existing cancel behavior or a confirmed/forced discard.
- Language remains owned by the Language Feature. Its Section is immediate-save, never dirty, and continues to update the entire Localized Surface without renderer reload.
- Move Organization name presentation out of Members into a distinct Organization Details contribution owned by the Organization Feature. Every active Member sees the authoritative name. Only Owner receives editable controls; Admin and Member receive a read-only presentation.
- Organization Details uses last-successful-write-wins and no version, ETag, merge, Realtime, or polling. It rereads on mount and after a confirmed discard; a failed save retains the draft.
- Members keeps Members and Pending Invitations as internal tabs. They are not persisted in Settings history. Re-entering Members or changing Organization selects Members. Pending Invitations is absent when the freshly verified role cannot manage invitations.
- Audit Log remains an Organization contribution and retains its RLS-direct read and local file export. The Settings coordinator treats the native save dialog and file write as one export-active phase that blocks navigation, Organization switch and normal close; cancellation produces no file and clears the phase immediately.
- Existing shared UI primitives are sufficient. This slice does not add another shared shadcn primitive or a generalized form/navigation framework.

### Membership verification and Organization-picker decisions

- Consolidate Settings permission checks behind one Organization Feature verification interface that returns only three externally meaningful outcomes: verified active Membership, confirmed Membership loss, or unknown due to network/service failure. Settings chrome, Organization Sections, post-command reconciliation and picker return behavior use this same seam rather than interpreting errors independently.
- Entering any Organization Section triggers Membership verification. Audit Log verifies before requesting Audit rows. Member/Invitation commands reread Membership, Members and Invitations after a terminal response. V1 adds neither Realtime nor polling.
- Unknown verification never implies lost access. Keep the current Section and previously loaded ordinary read-only content, mark authority as unverifiable, and disable actions requiring a fresh role. With no prior ordinary content, show a retryable loading/error state.
- Audit data fails closed while authority is unknown: do not start a read, and clear or withhold previously mounted Audit rows. If Membership is verified but the Audit data request itself fails, remain on Audit Log with a distinct retryable data error; do not render an empty log or permission-loss state.
- Only a successful verification that confirms lost Audit permission removes the navigation entry, clears mounted Audit data, and replaces the active Section with Members. Confirmed total Membership loss follows the existing blocking access-lost flow.
- Opening the Organization picker from Settings uses a Settings-origin mode. It retains the old Active Organization until a new selection succeeds, carries the Settings entry as the return target, and provides cancel. Startup-origin picker behavior remains unchanged.
- If the old Membership is still active, picker cancellation returns to the original Settings Section. If it ended while the picker was open, cancellation cannot restore it and follows normal selection/onboarding resolution.
- Successful Organization selection, Organization creation, or Invitation acceptance from Settings returns to the original Settings Section and applies permission fallback; the same successes from startup continue to Home.
- Dirty Profile or Organization Details must be discarded before Settings opens the picker. Once confirmed, the draft is final: picker cancellation remounts the Section from authoritative data rather than restoring the discarded draft.

### Trusted commands, authorization and contracts

- Invitation creation/resend/revocation, role change, member removal and leave continue to block Settings navigation, Organization switch, back and ordinary close while the command is pending.
- A command timeout means unknown result. Never retry the write automatically. First reread Membership, Members and Invitations; use the returned authority to show success or enable a safe retry.
- If the authoritative reread also fails, expose “result not yet confirmed,” disable the same write, and provide only an explicit recheck. Other actions that depend on that uncertain state remain disabled until a successful reread.
- `UpdateOrganizationSettings` keeps its existing route, request shape, 200 response, trimmed nonblank name validation, atomic Organization update plus immutable Audit Log entry, and no-email behavior. It changes authorization only: active Owner succeeds; active Admin and Member receive the existing `insufficient_organization_role` 403; ended/non-member callers retain the existing non-enumerating not-found behavior.
- The Server Identity Module remains the only writer because Organization name changes require an Audit Log entry. Do not move the write to Supabase client CRUD or depend on the Desktop role check.
- Update the public identity contract's authorization description and examples without introducing a new route, version, response envelope, schema, table, RLS policy, GRANT, migration, or idempotency mechanism.

### Shared-area, composition-root and rollback decisions

- Authentication typed IPC additions remain Domain-local. The generic Channel allowlist and Window platform behavior are supporting security surfaces and must be called out with impact and tests; generic preload gains no per-Domain method.
- Settings Page and App Shell changes are composition changes only: they assemble Feature interfaces and pass navigation state. They do not absorb form rules, Membership authorization, organization commands, or Supabase reads.
- The public contract is a shared-area change in the Owner-only Organization Details authorization ticket PR and must be called out with its response-conformance and authorization tests. No other root contract changes are expected.
- Authentication tickets revert independently in reverse dependency order: Remembered Email reverts its Domain/UI/IPC behavior together; native editing and password visibility remain separate Desktop boundaries; password and Session policy reverts only before the first real User and still requires an explicit security decision. After real Users exist, the strengthened security floor remains in place rather than being silently downgraded. An encrypted remembered-email file left by a downgraded build is inert and contains no password or token. No Authentication ticket adds a schema or data migration.
- Settings tickets revert independently in reverse dependency order. The Owner-only authorization ticket always reverts its Desktop presentation, Server authorization and contract description together; never roll back only its Server or only its Desktop half because that would recreate an inconsistent authorization story. The remaining Settings tickets own separate composition, verification, form, command, Audit or picker transitions and add no schema migration.

## Testing Decisions

Good tests cross the highest stable seam and assert externally observable behavior: rendered controls and focus, persisted encrypted outcomes, navigation destinations, HTTP status/error envelopes, authoritative rows, and files produced. They do not assert React hook layout, private helper calls, internal store fields, SQL statement order, or exact component trees. The Desktop Electron Playwright harness is the primary seam for both slices; narrower seams exist only where a UI path cannot prove configuration or negative authorization safely.

### Test seams

| Seam | Slice and observable coverage | Existing prior art |
| --- | --- | --- |
| **Electron Playwright with the disposable Supabase/Auth and Go harness** | Primary seam for both slices. Authentication covers Remembered Email success/failure/uncheck/restart/logout/signup/recovery boundaries, secure-storage unavailable/corrupt outcomes, initial focus, clipboard/context menu, independent password reveal, flow reset, blur/minimize concealment, localized hints/errors, transient restore and explicit revocation. Settings covers one-Section mounting, history replace/back/source fallback, every dirty/save/close outcome, Organization switch and picker origin, permission unknown/lost states, Members tabs, trusted-command timeout reconciliation, Audit data/export lifecycle, and Owner/Admin/Member presentation. | Existing authentication login/session-persistence/recovery suites; Settings Page, organization management, access-lost and Audit Log suites; real BrowserWindow evaluation and controllable network routing. |
| **Pinned Supabase Auth policy harness** | Authentication only. Proves minimum and maximum UTF-8 byte behavior, no character-class requirement, leaked-password rejection on signup/password update, fail-open behavior when the HIBP check is unavailable, one-hour JWT, refresh rotation, 14-day inactivity, 90-day time-box, and ordinary login despite a `weak_password` signal. This verifies deployment-equivalent behavior rather than only parsing configuration text. | Existing disposable Auth stack configuration, SMTP capture, password recovery and runtime-revocation acceptance. |
| **Server Identity Module HTTP interface with real database** | Settings only. Proves Owner success, Admin and Member 403 with the existing machine code, non-member non-enumeration, blank-name validation, atomic name plus Audit Log write, no Outbox row, unchanged response contract, and response-level OpenAPI conformance. | Existing Organization Membership command integration harness and settings-command test. |

- No new frontend unit-test framework is introduced. Pure tests may extend an already-running repository test runner only when a failure state cannot be controlled through the primary Electron seam; they do not replace end-to-end acceptance.
- Platform-native acceptance remains required for `safeStorage`: Keychain on macOS, DPAPI on Windows, Secret Service on Linux, and explicit rejection of Linux `basic_text`. CI environments without a native secure backend may skip only the native-persistence case, not the in-memory/no-plaintext behavior.
- Clipboard and right-click tests operate on real editable renderer controls. They verify the resulting field value and available edit roles rather than Window-platform implementation details.
- Password reveal tests assert input masking, retained value, independent controls, flow transition reset, BrowserWindow blur and minimize. They never log or snapshot raw passwords.
- Remembered Email tests inspect only the outcome needed to prove encryption/no plaintext, replacement and deletion. They do not couple to envelope field order or ciphertext bytes.
- Settings navigation tests use at least two distinct business-source entries so source preservation is not accidentally hard-coded to Home.
- Permission-unknown tests distinguish Membership refresh failure from confirmed loss and from Audit data failure; each must produce a different observable surface.
- Trusted-command timeout tests control both the initial response and authoritative reread, covering committed, uncommitted and still-unknown outcomes without repeating the write request.
- Authorization tests call the trusted command directly with Owner, Admin, Member and outsider identities; hiding a Desktop button is never accepted as security evidence.
- All new Localized Surface keys pass the existing Simplified Chinese/English completeness and packaged-localization checks.

### Acceptance boundaries and named checks

| Delivery mainline | Acceptance boundary | Named checks and required result | Rollback boundary |
| --- | --- | --- | --- |
| Authentication Usability | Remembered Email never stores a password or plaintext; all save/clear/failure/focus rules are observable; passwords are editable and safely obscured; final Supabase password and Session policy is enforced without a login weak-password gate; existing Session security remains intact. | `Authentication Usability Desktop E2E` — PASS; `Supabase Auth Policy Harness` — PASS; Desktop lint/typecheck/build and packaged localization — PASS; applicable native secure-storage acceptance — PASS. | Revert tickets in reverse dependency order; retain the strengthened security floor after real Users exist; no migration rollback. |
| Settings Information Architecture and Organization Authorization | One top-level Settings route renders one Section; all navigation/dirty/operation/permission/picker/export states follow the finalized design; every active Member can view Organization Details; only Owner can update through both Desktop and the trusted command. | `Settings Information Architecture Desktop E2E` — PASS; `Identity Organization Settings Authorization Integration` — PASS; OpenAPI response conformance — PASS; Desktop lint/typecheck/build and packaged localization — PASS. | Revert tickets in reverse dependency order; keep each cross-runtime authorization ticket atomic; no migration rollback. |

- After the last product-code edit in each implementation PR, run the smallest relevant check through the repository final-state-evidence route, review the final diff against its acceptance boundary, and record a closed finding ledger. CI's named Desktop, Server, mail/E2E and aggregate gates must all report terminal success where path classification requires them.

## Out of Scope

- Product code, test, configuration, migration, contract, or dependency implementation in this to-spec task.
- Remembered passwords, multiple remembered accounts, account chooser UI, password replay, biometric unlock, or using Remembered Email as Session authority.
- A weak-password migration, `weakPassword` login state, forced password-change route, or login gate for a successfully verified email/password.
- A new authenticated password-change screen; HIBP applies to existing or future provider-supported password creation/change interfaces without adding Governance UI here.
- Magic Link, social OAuth, anonymous login, SAML SSO, SCIM, MFA, CAPTCHA, device fingerprinting, or a general Session-management UI.
- A nested Settings route, Section URL/search/hash state, anchor scrolling, deep link, custom Electron protocol, or a second router.
- A `settings` Feature/Domain, dynamic Settings plugin registry, generalized navigation framework, or new shared UI primitive.
- Autosave, saving from the discard dialog, draft persistence, Settings crash recovery, cross-Section cache, version/ETag conflict detection, or conflict merging.
- Realtime or polling for Membership, Settings, Organization Details, Members, Invitations, or Audit Log.
- New database tables, columns, RLS policies, GRANTs, migrations, Audit Log semantics, Outbox templates, or email notifications.
- Changing Organization Membership roles, Invitation policy, Audit retention/export format, Profile validation, Language Mode semantics, or Active Organization startup behavior beyond the Settings-origin picker return path.
- System-forced process termination guarantees, cloud provisioning, Alibaba RDS work, production plan procurement, or unrelated Supabase infrastructure migration.

## Further Notes

- Repository inspection on 2026-08-13 confirmed the starting gaps this spec closes: encrypted Session persistence already exists; Remembered Email and password visibility do not; the local Supabase policy still uses a six-byte minimum with Session timeouts unset; Settings currently mounts multiple sections and uses anchor/scroll navigation; Organization name editing is embedded in Members; the trusted command currently permits Owner and Admin.
- Current Supabase sources were rechecked before publication. The [password security guide](https://supabase.com/docs/guides/auth/password-security) still documents configurable password strength, HIBP leaked-password protection, and the `WeakPasswordError` login signal for older passwords. The [Session guide](https://supabase.com/docs/guides/auth/sessions) still documents refresh-time enforcement of inactivity/time-box controls, a normally one-hour JWT, and `session_id` validation for sensitive actions. The current Auth implementation enforces the bcrypt limit as 72 UTF-8 bytes and supports HIBP fail-open. No relevant Auth breaking change in the current changelog makes the finalized design impossible.
- The Settings authorization tightening does not contradict ADR-0004 or ADR-0008: an audited Organization write remains a Go trusted command, while ordinary Membership and Organization reads remain direct RLS-protected Supabase reads.
- No new Domain term or ADR is required. If implementation discovers that fulfilling the behavior requires a Settings Domain, nested route, new shared layer, altered trusted-execution seam, schema/RLS change, or public contract shape change, stop and open a dedicated architecture task rather than expanding either slice silently.
- The two historical Organization Membership tickets that allowed Owner/Admin Organization name updates remain historical evidence only; their supersession notes already point to this Owner-only delivery.
