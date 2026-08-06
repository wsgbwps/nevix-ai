# 08 — Desktop 邀请自动浮现 + 接受邀请流

**What to build:** 被邀请人的加入通道。组织选择界面的邀请区（位于组织列表上方）经 RLS email 策略自动浮现当前用户 pending 邀请，不做纯手动入口；点选邀请浮出 6 位码输入，每次错误消耗 5 次尝试之一，过期或已失效的码给出明确提示（引导请求重发）。接受成功后新组织立即出现在组织列表并可切换，落点首页。文案以 `.scratch/identity-org-membership/copy-and-validation-baseline.md` 为基线，全部 Localized Surface 中英双语。

**Blocked by:** 04 — Active Organization：状态、设备记忆与启动三分支；06 — Go 邀请命令组 + 审计写入基建 + 携码模板

**Status:** ready-for-agent

- [ ] e2e：pending 邀请在选择界面自动浮现，无需手动入口
- [ ] e2e：输码接受全流程——错误计数、过期/失效提示、成功后组织即时入列表并落点首页
- [ ] 5 次尝试上限在界面上有对应反馈
- [ ] 全部新 Localized Surface 双语过发布检查；e2e 用例归入既有 tier
- [ ] apps/ 属 CI 门禁路径，走 feature branch + PR
