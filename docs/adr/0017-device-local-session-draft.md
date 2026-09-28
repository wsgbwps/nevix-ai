# ADR-0017: Draft 为设备本地状态，提交携带完整生成意图

## 状态

已接受 — 2026-09-02。取代 #150 实施规格中「会话草稿随写随存于服务端、submitTask 以 draft_revision 指针提交」的设计；该部分从未被 [ADR-0016](0016-ai-creation-v1-trusted-seams.md) 记录为架构决定，本文补记其退场与新基线。

2026-09-05 修订：补充已开始提交但尚未物化的 Draft 独立归属，以及跨重启保存的边界；配合 [Desktop ADR-0005](../../apps/desktop/docs/adr/0005-creation-operation-and-task-refresh-lifetimes.md) 的业务动作生命周期决定。本次新增行为已定稿，源码待实施。

2026-09-07 修订：本地草稿记录的解析对比记录更新的 Generation Parameter 字段宽容读取为未设置（null），已存字段类型不符仍整条拒绝——新增生成参数不再使已存草稿静默失效。字段清单及其派生架构见 [Desktop ADR-0006](../../apps/desktop/docs/adr/0006-generation-parameter-field-inventory.md)。

2026-09-17 修订：Team Publication 的 Create Similar 先由 Server 以幂等命令原子创建新的私有 Creation Session 与 User-owned Reference Material 记录，再由 Desktop 把返回的重映射生成意图写入设备本地 Draft；服务端仍不保存可编辑草稿。

2026-09-28 修订：同一 Workbench Context 的图片与视频改为各自独立的完整 Draft；切换 Media Type 只选择当前 Draft，不把另一媒体的输入带入校验或提交。

## 背景

V1 实施中，Draft（可编辑生成意图）承担了两个角色：随写随存（800ms 防抖 PUT `/creation/sessions/{id}/draft` → `creation_sessions.draft_*` 列与 `creation_session_draft_references` 表，迁移 0007）与提交锚点（submitTask 只携带 `idempotency_key + draft_revision`，Server 在准入事务复验 revision 并冻结自己存储的草稿）。#186 让任务卡片改用任务自己的冻结 Generation Specification 后，服务端草稿在 UI 上的消费者清零，剩余存在理由只有「跨设备/重启恢复」与「提交协议」两条。而为这两条付出的成本是 Creation Feature 中最复杂的 seam：自动保存管线与 SaveStatus/retrySave UI、saving/failed 阻塞提交、revision gating、多设备草稿竞态靠单行 UPDATE 串行化。产品对标（即梦网页端）表明输入草稿的持续持久化并非用户预期。

## 决策

- **Draft 是设备本地状态**：仅存于当前设备（renderer localStorage，按 `{userId}:{sessionId}` 键控，尚未开始提交的新创作为 `{userId}:new`），多设备互不相通；退出登录保留，删除会话时同步清除本地草稿。重启/渲染进程重载不丢，会话间切换靠本地副本恢复。
- **同一创作上下文按 Media Type 保留两份完整 Draft**：图片与视频分别保存提示词、Reference Mention、Reference Material 绑定和 Generation Parameter，切换只改变当前编辑的 Draft；Composer 的能力过期提示与提交准入只针对当前 Draft。新创作默认选择图片 Draft，即使能力清单暂不可用也可继续编辑；当前 Media Type 随上下文保存。旧版单份本地草稿按其已有 Media Type 归入对应 Draft；没有选定 Media Type 的旧草稿完整归入图片 Draft，另一份从空白开始，不丢弃已有输入。
- **已开始提交的新创作上下文有独立归属**：新创作开始物化/提交但尚未获得 Creation Session identity 时，两份 Draft、当前 Media Type 与上下文级操作提示作为整体从可复用的 `new` 槽移入独立的 pending 槽，并在现有会话列表中保留临时入口。创建成功后整体关联真实会话，失败时整体保留并显示错误；迟到结果不能覆盖或删除后来新建的上下文。这只服务于已开始提交的新创作，不扩展为任意多 Draft 管理器，具体本地键编码由实施决定。
- **两份 Draft 随创作上下文共同迁移**：新创作首次提交进入 pending，再物化为 Creation Session 时，未提交的另一 Media Type Draft 与当前选择一起迁移；任务的冻结 Generation Specification 仍只取提交时当前 Draft。进行中的素材上传留在其来源 Media Type，切换不取消；完成或失败只更新该 Draft。首次提交只等待当前 Draft 所需的素材，另一 Draft 的本地文件在 Session 创建后独立上传，其失败不阻止当前任务。同一 Workbench Context 仍最多一条未完成的准备／提交链，另一份 Draft 可继续编辑。
- **恢复编辑只覆盖目标 Media Type**：任务“重新编辑”和从资产发起的“做同款”选择来源任务的 Media Type，只替换那份 Draft 并保留另一份；从 Team Publication 创建新的 Creation Session 时，目标 Media Type 写入来源意图，另一份为空。
- **保存编辑内容与必要的未确认提示，不保存操作续跑上下文**：临时 Draft 与“此前结果未确认”提示可跨重启保留；不持久化完整操作链、File 或幂等重放上下文。安全恢复同次生成提交只在当前登录期间复用原载荷与幂等键；重启或重新登录后只核对已有 Go 事实，不保证认领旧操作，再次提交是新动作。
- **服务端不再保存可编辑草稿**：删除 PUT draft 端点、session detail 响应中的 `draft` 字段、`draft_revision` 请求字段及其专属 409 码（`draft_revision_conflict` / `draft_not_ready` / `draft_capability_stale`）；新迁移删除 0007 建立的草稿列与引用绑定表，与停写同一发布原子完成——on-prem 桌面与服务端同装同发（[ADR-0013](0013-onprem-single-tenant-delivery.md)），无外部契约消费者。
- **submitTask 请求体改为完整生成意图**（prompt、参数、引用绑定 + `idempotency_key`）：Server 在准入事务内校验能力一致性与 role/kind 兼容（原 SaveDraft 事务校验移入）并冻结为 Generation Specification；幂等仍由 `idempotency_key` 承担。
- **素材时机维持现状**：已有会话附加即上传（素材是会话资产，选择即落服务端），新创作推迟到会话物化时上传；附件上传失败的展示移入 reference deck 内联提示（不再借保存状态 chip）。
- **Create Similar 只物化服务端事实**：从有效 Team Publication 做同款时，Server 以 Desktop idempotency key 原子创建 Session 和归当前 User 的素材记录，并返回已重映射素材 identity 的生成意图；Desktop 将意图保存为本地 Draft。若本地保存失败，同 key 重试返回既有结果，不增加服务端 Draft、补偿事务或重复素材。

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
