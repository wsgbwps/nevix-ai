# 08 — Desktop 邀请自动浮现 + 接受邀请流

**What to build:** 被邀请人的加入通道。组织选择界面的邀请区（位于组织列表上方）经 RLS email 策略自动浮现当前用户 pending 邀请，不做纯手动入口；点选邀请浮出 6 位码输入，每次错误消耗 5 次尝试之一，过期或已失效的码给出明确提示（引导请求重发）。接受成功后新组织立即出现在组织列表并可切换，落点首页。文案以 `.scratch/identity-org-membership/copy-and-validation-baseline.md` 为基线，全部 Localized Surface 中英双语。

**Blocked by:** 04 — Active Organization：状态、设备记忆与启动三分支；06 — Go 邀请命令组 + 审计写入基建 + 携码模板

**Status:** in-review

- [x] e2e：pending 邀请在选择界面自动浮现，无需手动入口
- [x] e2e：输码接受全流程——错误计数、过期/失效提示、成功后组织即时入列表并落点首页
- [x] 5 次尝试上限在界面上有对应反馈
- [x] 全部新 Localized Surface 双语过发布检查；e2e 用例归入既有 tier
- [x] apps/ 属 CI 门禁路径，走 feature branch + PR

## Comments

- PR #44 follow-up 从本人 RLS 可见的 Profile 行恢复完成状态，并将它与首 Organization 创建 requirement 分开；注册临时内存信号不再能跨重启或另设备绕过必填 `display_name`。
- 新 `@smoke` E2E 覆盖“已验证、无 Profile、有 pending Invitation → 第一设备关闭 → 第二设备登录 → 保存显示名 → 有效码接受”，数据库断言只产生受邀 Organization 的 Member Membership；revoked Invitation 仍在错误 Sheet 关闭后从当前投影消失。
- Follow-up 未新增或修改 contract、CORS、schema、RLS policy 或 migration；这些共享/数据库影响仍限于本 PR 原有 invitation attempts、display snapshots 与 historical-code lookup 变更。PR 保持 draft，等待新 head CI 与 diff review。
