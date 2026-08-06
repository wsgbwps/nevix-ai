# 11 — Desktop 会话中失权检测 + 阻断对话框

**What to build:** 会话运行中失去 Membership 的检测与告知（定稿变体 A）。error-driven 检测：命令返 403/404 或 RLS 直读结果突变 → 重拉确认 → 退出该组织上下文并弹出阻断式对话框（标题含失去的组织名 + 说明 + "知道了"）；确认时该组织已从列表移除。落点：仍有其余组织 → 组织选择界面；无组织 → onboarding。V1 不上 Realtime。

**Blocked by:** 04 — Active Organization：状态、设备记忆与启动三分支；07 — Go 成员管理命令组 + 通知矩阵

**Status:** ready-for-agent

- [ ] e2e：会话中被移除成员 → 阻断对话框出现（含组织名），确认后退出组织上下文
- [ ] e2e：落点正确——有余组织进选择界面，无组织进 onboarding
- [ ] 失权后不再渲染或操作该组织的任何数据
- [ ] 全部新 Localized Surface 双语过发布检查；e2e 用例归入既有 tier；走 feature branch + PR
