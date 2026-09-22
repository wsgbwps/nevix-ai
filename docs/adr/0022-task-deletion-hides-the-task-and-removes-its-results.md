# ADR-0022: 任务删除 = 任务隐藏 + 结果移除

## 状态

已接受 — 2026-09-21。在 [ADR-0021](0021-asset-deletion-hides-task-results.md) 的可见性移除之外，新增任务级隐藏这一领域事实，并复用其既有的 Media Asset 逻辑删除机制；ADR-0021 的否决原样成立，不因本 ADR 修订。

自包含实施规格见 [#280](https://github.com/wsgbwps/nevix-ai/issues/280)；本 ADR 不表示源码已经实现。

## 背景

创作台上的终态任务卡今天没有删除入口。ADR-0021 只让"删除 Media Asset"在任务卡上留下回响——它的判据是"该任务曾形成 Media Asset、且形成的全部 Asset 都已逻辑删除"。失败卡与从未产出结果的卡永远不满足这条判据，卡片因此永久留在列表里，而它们恰恰是最想扔掉的一类。

要删的是一张卡，不是一次可见性事故。缺的是一个任务级命令，以及它需要落下的任务级事实。

## 决策

**任务删除 = 任务隐藏（`creation_generation_tasks.dismissed_at`）+ 结果移除（既有 Media Asset `deleted_at` 逻辑删除）：一条 `DELETE /creation/tasks/{taskID}`、一次事务。**

### 任务隐藏是新的领域事实

- `dismissed_at` 与 ADR-0021 的判据是两件事。ADR-0021 说"任务曾形成 Asset 且全部已逻辑删除时不再投影"，那是**资产删除的后果**；`dismissed_at` 说"User 删掉了这张卡"，是**用户意图本身**。两者都是任务列表的隐藏条件，来源不同、生命周期也不同。
- **粘性**：`dismissed_at` 对每一个被删的终态任务都写，不只零结果任务。部分成功或结局未知的任务日后仍可能落地结果，若只在"零结果"时写，卡片会随新结果自己冒回来——"删过的任务"必须是一条不会反转的事实。
- 任务列表投影因此同时带两条条件：`dismissed_at IS NULL` **且** ADR-0021 那条「曾形成 Media Asset 且全部已逻辑删除」规则。后者继续服务"从资产库删资产"那条路径，一天都没变。

### 与 ADR-0021 的否决不是同一回事

ADR-0021 否决的是「只删任务级展示、保留槽位结果」——用任务级隐藏**冒充**资产删除，于是卡片整张消失，结果却仍留在 Asset Library，答不上"4 张删 1 张"。本条决定不重复那个做法：隐藏任务的同时**真的走移除机制**，把它的结果按既有的 `deleted_at` 逻辑删除，资产事实与卡片事实在同一次事务里一起变。ADR-0021 的否决针对的是那次冒充，因此原样成立，不需要重开，也不因本 ADR 松动。

### 可见行为

- 被删任务不再出现在 `/creation/sessions/{sessionID}/tasks` 的任务列表；**任务详情仍可读**——`GET /creation/tasks/{taskID}` 照旧返回事实。隐藏的只是列表这个浏览面。
- 该任务尚未删除的全部 Media Asset 一并逻辑删除，随之离开 Asset Library。
- **只有终态任务可删**（成功 / 失败 / 取消 / 未知结局）。运行中与排队中的卡保持现状。
- **未知结局的任务可删**。代价是重做 / 重试入口随卡片一起消失；这是接受的取舍，不是遗漏。
- **有效 Publication 不撤回**：发布生命周期独立于任务与资产，团队仍可在 Inspiration Page 看到并复用它。
- 响应 `200` + 小响应体（非 204），携带被移除的槽位序号与跳过项；形状照 `deleteSession` 下移一层。

### 受限结果跳过，不阻断

非 Admin 的 `SoftDelete` guard 带 restriction 判据（`server/internal/creation/infrastructure/postgres/assets.go`），删不掉的行如实报告，整个操作仍然成功：受限结果进响应的 `skipped` 列表，从不致命。安全限制是可释放的治理态、不是创建者的删除意图（ADR-0021 同款理由），让一行受限结果挡住"扔掉这张卡"是把治理态当成用户意图。Admin 已解除的限制使该行可删——那是 `SoftDelete` 既有谓词，不是新规则。

### 不做什么

- **不真删、不回收字节。** 删除是纯逻辑删除；存储占用不因任务删除下降。生成侧仍无表级 `DELETE` 授权：迁移只新增 `dismissed_at` 列与列级 `GRANT UPDATE (dismissed_at)`（照 `server/internal/migration/migrations/0021_asset_library.sql` 给 assets 加 `UPDATE (deleted_at)` 的手法），属 [ADR-0015](0015-single-tenant-user-system-and-go-authorization.md) 最小权限。
- **不改写终态、不销毁用量预留。** 槽位终态与用量凭证一律留在原处。
- **不设 409。** 非终态目标与重复 DELETE 共用同一个 404——一个 guard、一条语句。客户端不会对这两种情况区别对待，两个 guard、两条语句换不来差别。
- **不改治理计数。** `CountTasksCreatedSince` 不因隐藏而变：被删的任务确实消耗过配额，隐藏是可见性操作，不是配额回滚。别让后人"修"它。

### 契约与实现形状

- **契约**：`contracts/creation.yaml` 的 `/creation/tasks/{taskID}` 增加 `delete`（`deleteGenerationTask`），返回 `TaskDeletionResult`（`removed_slot_indexes` + `skipped`，`skipped` 永不为 `null`）。不新增错误码，`ErrTaskNotFound` 沿用既有 404 映射。
- **实现**：终态规则已在 `TaskIsTerminal`，repo 层 guard 是它的 SQL 孪生；任务行先于资产行加锁（creation 写方一律父先子后）。
- **失效通知**：写事务内发一次 creation 失效事件（复用现有 hub），已打开的 Workbench 随之收敛。
- **判据推进**：同一次写事务一并推进来源任务的 `updated_at`（[ADR-0016](0016-ai-creation-v1-trusted-seams.md) 的判据合同：每次可见详情变化都必须改变它）。

## Considered Options

- **真删数据库记录。** 需给生成侧加表级 `DELETE` 授权、改写终态槽位、销毁用量凭证；且 `creation_media_assets.task_id` FK 为 `NO ACTION`，`creation_team_publications.source_asset_id` FK 同样使已发布过的结果根本删不掉。**且在用户视角换不来任何差别**。否决。
- **只删任务级展示、保留结果。** ADR-0021 已否决（见上），本 ADR 不翻案。否决。
- **为"非终态"与"已删过"分别设 409。** 两个 guard、两条语句，去换一个客户端不会区别对待的差别；`deleteSession` 的先例是同一个 404。否决。
- **只对零结果任务写 `dismissed_at`。** 部分成功与结局未知的任务日后可能落地结果，卡片会自己冒回来；粘性正是这条命令要买的东西。否决。
- **受限结果使整个删除失败。** 把可释放的治理态当成用户意图，还让一行受限结果挡住一条完全合法的删除。否决。
- **客户端本地过滤任务列表。** 骨架闪动与虚拟行缩水都会撞上阅读锚点（[ADR-0021](0021-asset-deletion-hides-task-results.md) 同款理由）。否决。

## 后果

- **跳过项的报告面在工作台范围**：卡片已经消失，报告挂不回卡上，因此是一条 `role="status"` 小字，存活到下一次任务操作或重新进入工作台。`already_removed` 不计入该行（后置条件已成立），只在 wire 上留痕。
- **被跳过的受限结果按定义仍留在 Asset Library**：这是"任务走了、结果留下"的唯一一面，且只发生在限制仍 active 时。
- **任务删除不撤回有效 Publication**：已发布作品在 Inspiration Page 照旧可见、可复用。Asset 与 Publication 生命周期互相独立，这是有意的，不是缺陷。
- **任务详情仍可读**：直接取详情的追溯与审计读取不受隐藏影响；隐藏只作用于列表投影。
- **未知结局任务可删的代价**：重做 / 重试入口随卡片消失，而它可能是拿回那次生成结果的唯一路径。已付费的未完成槽位随之失去入口——与 ADR-0021 删光最后一张资产同款取舍，有意为之。
- **非终态目标与重复 DELETE 都回答 404**：客户端必须把重复删除读成"目标已消失"，而不是需要呈现的错误。
- **响应丢失后的重试答 404**：桌面按失败处理，卡片留到下一次 reconcile 才消失。删除失败本身是静默的（与取消任务一致），卡片还在是唯一的反馈；要错误行是第二个决定。
- **治理计数不因隐藏而变**（见「不做什么」）：`CountTasksCreatedSince` 是已消耗配额的事实，不是活动任务的计数。
- 列级 `GRANT` 是一次授权变更，按 [`docs/agents/delivery.md`](../../docs/agents/delivery.md) 属高风险合并门，需要人在合并前批准。
