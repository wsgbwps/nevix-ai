# 07 — Go 成员管理命令组 + 通知矩阵

**What to build:** 其余四条 trusted command：LeaveOrganization（Member/Admin 可退出；结束保留行、重新加入插新行）、RemoveMember（Owner/Admin 移除成员，移除即时生效）、ChangeMemberRole（Owner 提升 Member 为 Admin、降级或移除 Admin；角色就地 UPDATE；"恰好一个 Owner"由命令事务保证）、UpdateOrganizationSettings（Owner/Admin 改组织名）。复用 ticket 06 的审计写入与 Outbox 双语模板基建，落地通知矩阵剩余四模板：admin_promoted / admin_demoted / admin_removed（各发 affected User + Owner，操作者是 Owner 也发）、member_removed（仅被移除者）。加入、退出、设置变更只写审计行不发邮件。V1 纯文本；运营可见性维持基线（failed 行保留、failed/cancelled 可区分，无告警与重投工具）。openapi 新增条目并在 PR 描述 call out。

**Blocked by:** 06 — Go 邀请命令组 + 审计写入基建 + 携码模板

**Status:** ready-for-agent

- [ ] 四命令集成测试通过，角色变更与"恰好一个 Owner"不变式经测试断言
- [ ] 审计行与通知矩阵逐事件核对：四个通知事件各发对收件人，加入/退出/设置变更不发邮件
- [ ] 被移除成员即时失权（RLS 只读活行）经测试验证
- [ ] 防枚举 404/403 语义一致；openapi 对照校验通过
- [ ] server/ 与 contracts/ 属 CI 门禁路径，走 feature branch + PR
