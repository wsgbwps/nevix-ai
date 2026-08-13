# 10 — Audit Log fail-closed 与确定性导出

**What to build:** 让 Organization Audit Log 成为独立 Settings Section，仅在 fresh Membership 确认 Owner/Admin 权限后读取敏感内容；权限无法验证、数据读取失败与确认失权分别呈现不同的用户可观察结果。同时把原生保存对话框和文件写入作为一个可确定的 export-active 阶段，取消时无文件、无残留导航锁。

**Blocked by:** 05 — Focused Account Settings 与普通关闭保护; 07 — Membership-verified Organization Settings

**Status:** ready-for-agent

**Consumes**

- 05 的 Section/navigation/ordinary-close coordinator 和 export-active lifecycle vocabulary。
- 07 的 verified/confirmed-loss/unknown Membership interface。
- 现有 Audit Log RLS-direct pagination、timeline/filter、CSV formula guard 和 Organization export IPC。
- 现有原生 save dialog 与本地文件写入能力。

**Produces**

- Audit Log Settings Section contribution 与 verified-before-read 行为。
- Membership unknown、confirmed permission loss 和 Audit data request failure 三种可观察结果。
- Audit contribution 的 export-active lifecycle report。
- 仅服务于本单一消费者的原生 save-dialog cancel E2E 控制 seam，不提升为通用测试框架。

**Owns**

- Audit 敏感内容的 fail-closed 语义与权限回退。
- Membership 验证成功后的 Audit data read/retry 状态，不把 data error 伪装成空日志或失权。
- save dialog、file write、cancel、success 和 failure 的单一 export lifecycle。

**Acceptance**

- [ ] 进入 Audit Log 时先通过 07 验证 Membership；只有 fresh Owner/Admin 才开始 Audit row request。
- [ ] Membership unknown 时不开始新 Audit read，且清除或隐藏已挂载 Audit rows，但不执行失权回退。
- [ ] Membership verified 但 Audit data request 失败时仍留在 Audit Log，清除 rows 并显示明确的可重试 data error，不显示空日志或 permission-loss 界面。
- [ ] 成功验证确认 Audit 权限丢失时，清除 rows、隐藏导航入口并 replace 当前 Section 为 Members。
- [ ] 原生 save dialog 打开或文件正在写入时，Section navigation、back、leave、Organization switch、picker entry 和 ordinary close 都被阻止。
- [ ] User 取消 save dialog 时立即清除 export-active，恢复导航，且没有生成文件。
- [ ] 成功导出仍稳定分页读取全部权威 rows，保持 CSV formula-injection guard 并显示实际导出数量。
- [ ] `Settings Information Architecture Desktop E2E`、Audit E2E regression、Desktop lint/typecheck/build 与 packaged localization 通过。
- [ ] 产品代码前记录短实施计划；最后代码修改后绑定 final-state evidence 并关闭 finding ledger。

**Parallel classification:** full parallel with 08 and 09 from the fixed point after 05 and 07; it may start before 06 finishes and becomes `parallel-ready` when its own blockers resolve.

**Absence test:** Organization Details、Members command 和 picker 票缺席时，Audit permission/data/export 闭环仍可独立验收。

**Commutativity test:** 与 08/09 任意顺序合并都保持 main 完整且 CI 通过；共享重叠仅为 additive Feature exports、i18n 和 app composition。
