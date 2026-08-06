# 10 — Desktop 审计日志时间线 + CSV 导出

**What to build:** Organization Audit Log 的查看与导出。采用定稿的 B 时间线：按天分组叙事时间线（"林晓 移除成员 → 李其 · 11:48"式行，直接消费 ADR-0009 写入时快照的 actor/target 显示名）；动作过滤 Select；CSV 导出按钮 + 导出反馈。导出为 Desktop 经 RLS 直读分页 + 本地写文件，不建服务端导出接口。审计入口归入设置页组织组导航，Member 角色不显示（RLS 亦在数据层拒绝）。

**Blocked by:** 04 — Active Organization：状态、设备记忆与启动三分支；06 — Go 邀请命令组 + 审计写入基建 + 携码模板

**Status:** ready-for-agent

- [ ] e2e：Owner/Admin 查看按天分组的叙事时间线，行内容含快照显示名、动作、目标与时间
- [ ] e2e：动作过滤 Select 生效
- [ ] e2e：CSV 导出写出本地文件并给出反馈，内容与分页直读结果一致
- [ ] Member 无审计入口，直读 audit_logs 被 RLS 拒绝
- [ ] 全部新 Localized Surface 双语过发布检查；e2e 用例归入既有 tier；走 feature branch + PR
