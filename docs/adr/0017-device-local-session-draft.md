# ADR-0017: Draft 为设备本地状态，提交携带完整生成意图

## 状态

已接受 — 2026-09-02。取代 #150 实施规格中「会话草稿随写随存于服务端、submitTask 以 draft_revision 指针提交」的设计；该部分从未被 [ADR-0016](0016-ai-creation-v1-trusted-seams.md) 记录为架构决定，本文补记其退场与新基线。

2026-09-05 修订：补充已开始提交但尚未物化的 Draft 独立归属，以及跨重启保存的边界；配合 [Desktop ADR-0005](../../apps/desktop/docs/adr/0005-creation-operation-and-task-refresh-lifetimes.md) 的业务动作生命周期决定。本次新增行为已定稿，源码待实施。

## 背景

V1 实施中，Draft（可编辑生成意图）承担了两个角色：随写随存（800ms 防抖 PUT `/creation/sessions/{id}/draft` → `creation_sessions.draft_*` 列与 `creation_session_draft_references` 表，迁移 0007）与提交锚点（submitTask 只携带 `idempotency_key + draft_revision`，Server 在准入事务复验 revision 并冻结自己存储的草稿）。#186 让任务卡片改用任务自己的冻结 Generation Specification 后，服务端草稿在 UI 上的消费者清零，剩余存在理由只有「跨设备/重启恢复」与「提交协议」两条。而为这两条付出的成本是 Creation Feature 中最复杂的 seam：自动保存管线与 SaveStatus/retrySave UI、saving/failed 阻塞提交、revision gating、多设备草稿竞态靠单行 UPDATE 串行化。产品对标（即梦网页端）表明输入草稿的持续持久化并非用户预期。

## 决策

- **Draft 是设备本地状态**：仅存于当前设备（renderer localStorage，按 `{userId}:{sessionId}` 键控，尚未开始提交的新创作为 `{userId}:new`），多设备互不相通；退出登录保留，删除会话时同步清除本地草稿。重启/渲染进程重载不丢，会话间切换靠本地副本恢复。
- **已开始提交的临时 Draft 有独立归属**：新创作开始物化/提交但尚未获得 Creation Session identity 时，移出可被后续新 Draft 复用的 `new` 槽，保留独立本地 Draft 与现有会话列表中的临时入口。创建成功后关联真实会话，失败时保留 Draft 与错误；迟到结果不能覆盖或删除后来新 Draft。这只服务于已开始提交的 Draft，不扩展为任意多 Draft 管理器，具体本地键编码由实施决定。
- **保存编辑内容与必要的未确认提示，不保存操作续跑上下文**：临时 Draft 与“此前结果未确认”提示可跨重启保留；不持久化完整操作链、File 或幂等重放上下文。安全恢复同次生成提交只在当前登录期间复用原载荷与幂等键；重启或重新登录后只核对已有 Go 事实，不保证认领旧操作，再次提交是新动作。
- **服务端不再保存可编辑草稿**：删除 PUT draft 端点、session detail 响应中的 `draft` 字段、`draft_revision` 请求字段及其专属 409 码（`draft_revision_conflict` / `draft_not_ready` / `draft_capability_stale`）；新迁移删除 0007 建立的草稿列与引用绑定表，与停写同一发布原子完成——on-prem 桌面与服务端同装同发（[ADR-0013](0013-onprem-single-tenant-delivery.md)），无外部契约消费者。
- **submitTask 请求体改为完整生成意图**（prompt、参数、引用绑定 + `idempotency_key`）：Server 在准入事务内校验能力一致性与 role/kind 兼容（原 SaveDraft 事务校验移入）并冻结为 Generation Specification；幂等仍由 `idempotency_key` 承担。
- **素材时机维持现状**：已有会话附加即上传（素材是会话资产，选择即落服务端），新创作推迟到会话物化时上传；附件上传失败的展示移入 reference deck 内联提示（不再借保存状态 chip）。

## Considered Options

- **即梦完全对等（纯内存，重启即丢）**：更简单，但放弃「重载不丢」的原始设计目标，且桌面用户对重启丢长 prompt 的痛感高于网页刷新；否决——localStorage 键控几十行即可保住该目标。
- **维持服务端草稿（跨设备恢复 + revision 指针提交）**：为最低频场景（跨设备续写未提交草稿）维持最复杂的 seam 与竞态串行化；否决。
- **素材统一推迟到提交时上传**：消灭双路径，但已有会话「重启不丢附件」行为退化且 localStorage 存不了 File；孤儿素材是今天就存在、与本次改动正交的问题；否决。
- **保留死列不 drop**：git 历史即回滚路径，死列只会制造下一个「这是干嘛的」；否决。

## 后果

- 实施前按 AGENTS.md 高险项规则先在 `.scratch/` 写实施计划（公共契约 `contracts/creation.yaml` + 持久数据迁移）。
- 多设备并发提交各自冻结各自的意图（last-writer-wins），草稿竞态不复存在。
- [Desktop 词典](../../apps/desktop/CONTEXT.md)的 Draft 词条已改为设备本地语义；`domain.SessionDraft` 收敛为提交载荷类型，`GetWithDraft` 收敛回 `Get`。
- 契约 breaking change 仅限同装同发的 on-prem 组合内成立。
