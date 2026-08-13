# 07 — Go 成员管理命令组 + 通知矩阵

**What to build:** 其余四条 trusted command：LeaveOrganization（Member/Admin 可退出；结束保留行、重新加入插新行）、RemoveMember（Owner/Admin 移除成员，移除即时生效）、ChangeMemberRole（Owner 提升 Member 为 Admin、降级或移除 Admin；角色就地 UPDATE；"恰好一个 Owner"由命令事务保证）、UpdateOrganizationSettings（Owner/Admin 改组织名）。复用 ticket 06 的审计写入与 Outbox 双语模板基建，落地通知矩阵剩余四模板：admin_promoted / admin_demoted / admin_removed（各发 affected User + Owner，操作者是 Owner 也发）、member_removed（仅被移除者）。加入、退出、设置变更只写审计行不发邮件。V1 纯文本；运营可见性维持基线（failed 行保留、failed/cancelled 可区分，无告警与重投工具）。openapi 新增条目并在 PR 描述 call out。

**Blocked by:** 06 — Go 邀请命令组 + 审计写入基建 + 携码模板

**Status:** resolved — PR [#42](https://github.com/wsgbwps/nevix-ai/pull/42) merged into `main` as [`200fd74`](https://github.com/wsgbwps/nevix-ai/commit/200fd74dfe6a1dfc89dd3984b9dc89791f458be7) on 2026-08-11

**Superseded authorization:** 后续 Authentication Usability and Settings Information Architecture 设计将 `UpdateOrganizationSettings` 收紧为仅 Owner 可执行；原 PR 的 Owner/Admin 规则是历史实现状态，不再是下一次交付的目标授权。

- [x] 四命令集成测试通过，角色变更与"恰好一个 Owner"不变式经测试断言
- [x] 审计行与通知矩阵逐事件核对：四个通知事件各发对收件人，加入/退出/设置变更不发邮件
- [x] 被移除成员即时失权（RLS 只读活行）经测试验证
- [x] 防枚举 404/403 语义一致；openapi 对照校验通过
- [x] server/ 与 contracts/ 属 CI 门禁路径，走 feature branch + PR

## Comments

- 2026-08-12：验收完成。PR [#42](https://github.com/wsgbwps/nevix-ai/pull/42) 已于 2026-08-11 通过 feature branch 合并到 `main`（`200fd74`）；全部 review threads 已解决。PR 的 Server CI、真实 Supabase/Mailpit Mail Smoke、Desktop E2E Smoke 与总 CI gate 均通过，覆盖四命令、审计/通知矩阵、单 Owner 不变式、移除后即时 RLS 失权、404/403 防枚举语义与 OpenAPI 响应对照。本次关闭前复跑 `go test ./...` 与 `go vet ./...` 通过。
