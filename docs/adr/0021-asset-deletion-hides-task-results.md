# ADR-0021: Media Asset 删除在来源 TaskCard 上呈现为结果移除

## 状态

已接受 — 2026-09-20。修订 [issue #80](https://github.com/wsgbwps/nevix-ai/issues/80) 未表态的一处，并细化 [ADR-0018](0018-result-reuse-reupload-in-renderer.md) 的槽位结果合同。

自包含实施规格见 [#262](https://github.com/wsgbwps/nevix-ai/issues/262)；本 ADR 不表示源码已经实现。

## 背景

删除 Asset Library 中的 Media Asset 后，其来源 Generation Task 的 TaskCard 仍原样展示该槽位结果——用户视为缺陷上报。

核实后确认这是既有决定的结构性后果，不是实现遗漏：

- [issue #80](https://github.com/wsgbwps/nevix-ai/issues/80) 定了"每个成功槽位恰好关联一个独立 Media Asset"与"Generation Result 没有独立身份或生命周期"。
- [ADR-0018](0018-result-reuse-reupload-in-renderer.md) 定了槽位结果"只有 checksum、MIME 与尺寸元数据，没有 material 身份"。
- `contracts/creation.yaml` 的 `deleteAsset` 定了"删除只隐藏 Asset，不撤回有效 Publication，也不删除共享对象"。

而 `creation_media_assets.blob_key` 与 `creation_generation_slots.result_blob_key` **是同一个已验证对象**（migration `0021_asset_library.sql` 表头注释即以此解释逻辑删除）。一个 blob、两行记录：要让任务结果继续可取字节，Asset 行就只能逻辑删除。

于是删除 Asset 在可见面上没有任何回响——这是需要补的洞，不是需要撤的决定。

## 决策

**删除 Asset 表现为其结果的可见性移除，而不是任何数据删除。**

### 可见行为

- 已逻辑删除 Asset 对应的槽位，在任务详情里不再展示结果。
- 槽位仍是 `succeeded`，任务的成功计数、`status` 与用量事实**一律不变**；该槽位不进入"重试未完成项"的集合。
- 当某任务**曾形成过 Media Asset、且形成的全部 Asset 都已逻辑删除**时，该任务不再出现在 Creation Workbench 的任务列表。
- 一致关闭三处：任务卡片展示、下载 `/creation/tasks/{taskID}/slots/{slotIndex}/result`、复用命令 `createMaterialFromResult`。只关展示而留着下载与复用等于没删。
- Admin 的"安全限制"（restriction）不参与：它是可释放的治理态，不是创建者意图。

### 不做什么

- **不真删。** 不需要新增 `DELETE` 授权、不改写槽位终态、不销毁用量预留。`creation_generation_tasks` / `_slots` / `_reservations` 今天对 `identity_app` 只有 `SELECT, INSERT, UPDATE`，`creation_media_assets` 只有 `SELECT, INSERT` 加列级 `UPDATE (deleted_at)`——生成侧无 `DELETE` 是逐表挑出来的（对比 `creation_sessions`、`creation_reference_materials` 都有），属 [ADR-0015](0015-single-tenant-user-system-and-go-authorization.md) 最小权限。
- **不改写终态槽位。** `creation_generation_slots_result_pairing_check` 规定 `(status = 'succeeded') = (result_blob_key IS NOT NULL)`，且终态写入一次永不改写；"结果被删"因此只能是读取投影上的事实。
- **不回收字节。** blob 仍被槽位引用，删除是纯可见性操作。

### 契约与实现形状

- **槽位级**：任务详情的槽位携带 `result: null` 加显式 `result_deleted`。零新增字段的方案（靠 `status = succeeded` 且 `result = null` 这个今天不可能的组合当判据）被否决——投影一旦因别的 bug 置空 result，界面就会谎报"已删除"，而这是 [ADR-0016](0016-ai-creation-v1-trusted-seams.md) 下的可信 seam。
- **任务级**：`/creation/sessions/{sessionID}/tasks` 列表直接不返回上述任务。判据是两条 EXISTS：`EXISTS(该任务有 Asset 行)` 且 `NOT EXISTS(该任务有 deleted_at IS NULL 的 Asset 行)`。客户端不自行 `.every()` 过滤——那会让卡片先渲染成骨架再消失，并让 `gallery.tasks` 在详情落地后缩水，正撞 [Desktop ADR-0005](../apps/desktop/docs/adr/0005-creation-operation-and-task-refresh-lifetimes.md) 保护的阅读锚点。
- **失效**：`AssetService.Delete` 写事务成功后发布一次 creation 失效事件，复用现有 hub。今天该路径不发任何事件（对比 task/publication service 都发），只靠 `onAssetsChanged()` 重读资产墙；没有这一步，投影改了也不会到达已渲染的 Workbench。
- **判据推进**：删除改变任务详情的可见内容，所以同一次写事务一并推进来源任务的 `updated_at`（[ADR-0016](0016-ai-creation-v1-trusted-seams.md) 的判据合同：每次可见详情变化都必须改变它）。只发事件不够——Desktop 按判据决定是否重读详情，判据不动时槽位级投影永远到不了已渲染的 Workbench；而按 ADR-0016，判据该由服务端推进，不是客户端绕过。
- 任务**详情**不 404：整张任务只是从列表浏览面消失，直接取详情仍返回事实。

### 保留的不对称

有效 Publication 不因 Asset 删除而撤回，也不因结果移除而消失；团队仍可在 Inspiration Page 看到并复用该作品。Asset 生命周期与 Publication 生命周期互相独立，这是有意的，不是缺陷。

## Considered Options

- **真删数据库记录，结果全删光则连任务一起删。** 需要给生成侧表加 `DELETE` 授权、改写终态槽位、销毁 `creation_generation_reservations` 的用量凭证；且 `creation_media_assets.task_id` FK 为 `NO ACTION`，任务行在 Asset 行（含已软删的）存在时删不掉，`creation_team_publications.source_asset_id` FK 同样使已发布过的结果根本无法删除。**且在用户视角换不来任何差别**——展示、下载、复用它全都已经关闭。否决。
- **客户端本地抵消。** 任务列表摘要不含槽位，详情虽会为窗口内每个任务读取（`needsDetailRead` 对未缓存项返回 true），但先骨架后消失的闪动与虚拟行缩水都会落到阅读锚点上。否决。
- **把隐藏槽位置为失败态。** 违反 `result_pairing_check`，且会让失败计数与"重试未完成项"凭空多出槽位。否决。
- **只删任务级展示、保留槽位结果。** 不能回答"4 张删 1 张"这个原始场景。否决。

## 后果

- 删除确认文案必须改：`i18n/resources.ts` 的 `assets.deleteConfirm` 与 `assets.batch.removeConfirm` 今天承诺"任务记录仍会保留"，在新行为下是假话；要改为说明结果会从任务卡片移除、最后一张被删时整张卡片消失、已发布内容仍不撤回。
- **失败槽位的重试入口随之消失**：`partially_succeeded` 任务重试创建新任务（quantity 为未成功槽位数），卡片一消失该入口即不可达，而那些槽位是已付费的。这是"删光"最容易让人后悔的副作用，属有意取舍。
- 阅读锚点要按 [Desktop ADR-0005](../apps/desktop/docs/adr/0005-creation-operation-and-task-refresh-lifetimes.md) 已有的"历史插入"对称处理**窗口中间的行删除**。
- 槽位结果下载的守卫是一次授权决定变更，按 [`docs/agents/delivery.md`](../docs/agents/delivery.md) 属高风险合并门，需要人在合并前批准。
