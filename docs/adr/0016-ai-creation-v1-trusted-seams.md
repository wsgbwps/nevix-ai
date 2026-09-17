# ADR-0016: AI Creation V1 可信 seam 基线与旧假设退场

## 状态

已接受 — 2026-08-26。权威来源为 [#93](https://github.com/wsgbwps/nevix-ai/issues/93) 收敛出的实施规格 [#150](https://github.com/wsgbwps/nevix-ai/issues/150)；本 ADR 把规格中跨 Module、跨 context 的责任 seam 固化为仓库权威架构决定，供实施切片直接遵循，不重开已关闭决策。

2026-09-01 修订：Capability Manifest 改为随代码发布的版本化合同；真实 Provider smoke 仅是人工发布检查，不再生成或部署运行时 evidence，也不参与 Server 启动或实例能力激活。本修订取代 #150、#158 与 #166 中关于 Production Readiness evidence 运行时门控的设计。

2026-09-02 修订：会话草稿的存储与提交锚点改由 [ADR-0017](0017-device-local-session-draft.md) 决定——Draft 为设备本地状态，submitTask 携带完整生成意图；#150 中「草稿随写随存于服务端、draft_revision 指针提交」的设计随之作废。

2026-09-05 修订：为任务增量刷新补充单任务详情一致读取与可靠变化判据的合同；#190 已验证并复用 `updatedAt`，不增加 `revision` 或 migration。实现与测试证据见下文。

2026-09-08 修订（规格 [#215](https://github.com/wsgbwps/nevix-ai/issues/215)，[#214](https://github.com/wsgbwps/nevix-ai/issues/214) 前置）：增加单一 OSS/COS Object Storage Connection 的实例级配置与凭据 seam；永久 Reference Material 改为 creator-private 持久上传租约、Desktop 单次预签名 PUT 与 Go 权威 finalize。Creation Credential Master Key 同时保护 AI Provider 与 Object Storage 凭据。

2026-09-09 修订（[#218](https://github.com/wsgbwps/nevix-ai/issues/218)，后续实现归 [#220](https://github.com/wsgbwps/nevix-ai/issues/220)）：Reference Material 的单次预签名 PUT 改由 Electron Main 原生流式执行，删除生产 bucket CORS 与连接 canary OPTIONS 依赖。Go 的短期单对象签名、禁止覆盖和权威 finalize 不变；Renderer 不接触磁盘路径、文件字节或签名 URL。

2026-09-14 修订：Reference Material 的显示类读取改用 Go 授权的第三条窄例外——Creator 通过 owner 校验后获得约 10 分钟、单一精确 key 的预签名 GET URL：缩略图为 provider 端缩小（宽 ≤320、WebP）进 Renderer `<img>`，预览大图为图片缩小（宽 ≤2048、WebP）或视频/音频原始字节进 `<video>/<audio>`（CSP 相应放行 `img-src https:` 并补 `media-src`）；素材本体下载仍经 Go 授权出口，canary 与 finalize 责任不变。

2026-09-15 修订：Reference Material 的 Composer 生命周期与冻结 TaskCard 展示生命周期分离。提交准入原子持久化 Generation Task 对素材的保留关系；从 Composer 移除后不再列表或参与新任务，但同一 Creator 的既有任务仍可凭冻结 material id 重新获得短时缩略图 URL。精确对象只在素材已移除且最后一个任务保留关系结束后进入既有持久 cleanup worker。

2026-09-17 修订：Media Asset 改为创建者与 Admin 可读，只有有效 Team Publication 对全体 active User 可读；Admin 通过 Inspiration Page 获得成品级窄读取能力，可查看全体尚未逻辑删除的成功 Media Asset（含受限成品）及每个成品实际使用的 Generation Specification 与 Reference Material，但不能据此浏览整个 Creation Session 或复用未发布作品。Team Publication 与 Create Similar 以不同 User-owned Reference Material 记录共享同一不可变存储对象，撤回只阻止新的复用。

## 背景

AI Creation V1 的产品决策分散在 Wayfinder map #77 的 19 张已关闭 decision tickets 与多份 ADR 中；旧票建立于 Organization、Supabase/RLS、Desktop 直连数据面等前提之上。#93 清空全部决策前沿并取代早期假设，#150 把最终边界收敛为单一规格。若不在架构文档中固化，实施 agent 容易复活已被取代的设计。本 ADR 与 [ADR-0012](0012-unified-ai-creation-owner.md)（owner 统一）、[ADR-0014](0014-go-sole-trusted-data-plane.md)（数据面）、[ADR-0015](0015-single-tenant-user-system-and-go-authorization.md)（用户系统与授权）互补，各自保持单一权威说明。

## 决策

### 旧假设退场

以下前置假设全部退场，实施不得从旧票或旧文档恢复；作废 ADR 原文仅为历史存档：

- **Organization、Membership、Owner**：多组织概念已随单租户私有化移除（[ADR-0015](0015-single-tenant-user-system-and-go-authorization.md)）；发布词汇使用 Team Publication，角色只有 Admin/Member。
- **Supabase（Auth/RLS/Data client/Storage Policy）、Supabase Broadcast**：Supabase 整体退场（[ADR-0013](0013-onprem-single-tenant-delivery.md)、[ADR-0014](0014-go-sole-trusted-data-plane.md)），授权在 Go 层，推送是 SSE。
- **通用 Storage Grant / 无约束预签名直连**：仍然退场。当前只保留三条由 Go 授权的窄能力：Desktop Creator 对一个随机 key 的限时 Reference Material PUT、外部 AI Provider 对一个 Provider Transfer Object 的限时 GET，以及当前已授权 Renderer 对一个 Reference Material 精确 key 的限时缩略图/预览 GET；三者都不暴露 AK/SK、List、任意 key 或跨对象能力（[ADR-0014](0014-go-sole-trusted-data-plane.md)）。
- **独立 creation 数据库角色**：不存在按域拆分的第二执行角色；Creation 写事务直接以最小权限 `identity_app` LOGIN 角色运行（见下）。
- **Deployment Administrator**：不存在产品内的部署管理员主体；部署侧责任（认领、证书、备份）由部署方经 Instance Claim 与交付资产承担，治理主体只有 Admin/Member。
- **外部 Secret Store 前置要求**：Creation 外部连接凭据使用本地 AEAD（见下），不依赖 Vault 等外部服务。

**2026-08-26 后续决定（覆盖 #93）**：V1 不包含 User 举报入口、Reports 聚合或 report 状态机，不交付 report schema/API/UI/测试；内容安全只保留 Admin 直接限制与解除（active/released 实例级限制 + 脱敏 Audit Log）。

### 可见性模型（权威）

- **creator-private**：Creation Session、Generation Task、Generation Result 与 Result Slot 只允许创建者直接读取；Reference Material 与 Generation Specification 默认遵循同一规则。Admin 没有 Creation Session 或任意 Task 的浏览旁路，但可通过一个成功 Media Asset 精确读取该成品冻结的 Generation Specification 与其中实际引用的 Reference Material，包括顺序、角色和短时媒体预览；该窄读取不暴露同 Session 的其他素材、任务或供应商原始 payload。
- **asset-readable**：Media Asset 默认只允许创建者与 Admin 读取。Admin 的 Inspiration 投影列出所有尚未逻辑删除的成功 Asset，包括未发布或处于 active 安全限制的成品；失败 Result Slot 没有 Media Asset，不进入该投影。Creator 可查看、下载、删除、直接复用自己的生成来源或发布；Admin 可查看、下载、删除或安全限制，但读取未发布 Asset 不改变发布状态，也不能据此发布或 Create Similar。
- **team-readable**：只有有效 Team Publication 对全体 active User 可见。只有来源 Asset 创建者可首次发布；Publication 发布者或 Admin 可撤回，撤回不恢复为有效状态。
- 所有 Creation route 在 Server 显式挂 `RequireActiveUser` 或 `RequireAdmin`；Desktop 可见性门控不是授权真相。

### Team Publication 与 Create Similar

- 发布不提供第二套内容编辑器或素材挑选器：命令固定保存目标 Media Asset、其冻结 Generation Specification，以及该 Specification 实际使用的全部 Reference Material 顺序、角色和声明版本。素材上传时已有的权利声明继续适用；Desktop 只在提交前展示将向 Team 开放的确认摘要。
- 每个 Media Asset 最多一个有效 Publication。重复发布以 Desktop idempotency key 返回当前有效 Publication；撤回使其永久失效，再次发布创建新的 identity。Inspiration 只把当前有效者标为“已发布”，撤回历史不形成产品 UI。
- Publication 固定发布时的 creator identity 与 display name 快照。发布者账号停用只终止其 Session 与新操作能力，不改变仍有效 Publication；Admin 继续拥有撤回和安全限制能力。
- Create Similar 以一个 Desktop idempotency key 在单个 Creation write transaction 中复验 Publication 仍有效，并为当前 User 原子创建新的私有 Creation Session 与 User-owned Reference Material 记录；新记录引用快照中的同一不可变对象，不复制文件。响应返回已重映射素材 identity 的生成意图，Desktop 再把它写入该设备的本地 Draft；本地保存失败后的同 key 重试返回同一 Session、素材和意图，不重复创建。
- Publication 保存的模型或参数退出当前 Capability Manifest 时，Create Similar 仍返回原值并明确标记不可提交；User 必须改成当前有效值后才能提交 Generation Task。Server 与 Desktop 都不得静默替换模型、参数或参考素材。
- 有效 Publication 允许 active User 查看与下载发布成品、查看共享生成信息与素材预览并 Create Similar；Reference Material 原文件仍只允许其记录 owner 下载。Admin 可按同一路径复用有效 Publication，也可撤回或安全限制，但不能从未发布 Asset 复用。
- 删除来源 Media Asset 只把 Asset 从 Creator 的 Asset Library 与 Admin 的 Asset 投影移除，不撤回或改变仍有效的 Publication；删除确认必须说明这一点。有效 Publication 继续保留媒体对象并提供查看、下载和 Create Similar，直到发布者或 Admin 显式撤回。

### 安全限制

- Admin 对 Media Asset 施加 active 限制时，普通读取与下载、发布、新的 Create Similar 立即停止，全部关联有效 Publication 进入终止状态；Admin 仍可在 Inspiration 中查看受限成品、冻结 Specification 与实际使用素材的预览，以完成判断和解除。
- released 不恢复任何旧 Publication；Creator 如需再次共享，必须创建新的 Publication identity。限制不追溯撤销此前已由 Create Similar 创建的 User-owned 素材记录、本地 Draft 或已准入 Generation Task，避免建立跨 Session 级联撤销图。

### 认证与授权注入

Session 认证与 Reauthentication Proof 归 Identity（[ADR-0015](0015-single-tenant-user-system-and-go-authorization.md)）。Creation 通过 composition root 注入的窄 public interface 消费 authenticated principal 与 exact-action proof：不 deep-import Identity implementation，不复制凭据验证。AI Provider 与 Object Storage 的创建、替换/轮换、删除及凭据恢复分别使用关闭词表中的 exact action；proof 由当前密码签发、五分钟有效、opaque hash 持久化、单次消费，消费成功后即使后续业务命令失败也不恢复。

### Object Storage Connection 管理 seam

- 每个 Deployment Instance 最多一条连接，provider 为 `oss|cos` 二选一；运行时只以简单 switch 构造当前 provider-specific adapter。OSS/COS 生产实现使用对应官方 SDK，共享 Creation 内部窄 BlobStore seam；不建立 adapter registry、plugin system 或通用 S3 runtime。
- 首位 Admin 在 Instance Claim 后通过 AI Creation Settings 配置。创建、空实例位置替换、凭据轮换、删除和恢复要求 `RequireAdmin`、可信 HTTPS 与各自 exact-action proof；Admin 读取脱敏状态及用已保存凭据 recheck 不消费 proof。Desktop 不保存或回显 AK/SK。
- 候选配置先在事务外执行 provider-specific canary：随机精确 key 的 Put/Head/Open/Range/Delete、固定方法与固定请求头的预签名 PUT、同 key 第二次写必须 409、匿名 GET 拒绝和精确清理。匿名 GET 仅接受 401、403 或 404，任何 2xx 都失败；canary 不发送 CORS OPTIONS。Nevix 不申请 List、ACL、Versioning 或 Lifecycle 管理权限；全部通过后才在 verified Creation write transaction 中以实例级单调递增 revision/CAS 激活密文并 append Audit，失败不覆盖旧连接，删除后重建也不复用旧 revision。
- 持久状态只有 `unconfigured|ready|credential_unavailable`；瞬时 availability、checked-at 与安全错误码是观察值，不改变配置状态，不做后台探活。Server 在未配置、凭据不可用或连接瞬时故障时仍启动，只有依赖 Storage 的 Creation 命令 fail closed。
- 没有永久对象、有效 Reference Material Upload、Provider Transfer Object 或 cleanup backlog 时可以替换/删除位置；首个永久对象后 provider、region、bucket 永久冻结，只允许同位置轮换凭据。计划轮换保留旧云 key 至最长 24 小时 Provider Transfer Object URL 失效；紧急撤销可使在途上传/生成失败。

### Reference Material Upload 可信 seam

- Reference Material Upload 是独立 creator-private 持久授权租约，不给 immutable Reference Material 增加 uploading 状态。申请、状态、finalize 与 abort 均挂 `RequireActiveUser` 并在 Creation 命令/查询层检查 Creator 和 Creation Session ownership；Admin 没有旁路。
- 申请记录随机最终 object key、filename、declared kind/MIME/size、rights/claims version、Desktop idempotency key、60 分钟 PUT 截止与 90 分钟 finalize 截止。同 key/同 payload 返回原 Upload，不同 payload 409；过期后必须使用新 key。
- Go 只预签 `Content-Type`、upload ID metadata 与当前 provider 的 [`x-oss-forbid-overwrite:true`](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject) 或 [`x-cos-forbid-overwrite:true`](https://cloud.tencent.com/document/product/436/7749)。bucket 必须关闭版本控制，并由激活 canary 证明第二次写同 key 返回 409；不要求 Desktop MD5，不把 Content-Length 或 ETag 当内容证明。
- Renderer 只选择 `File` 并展示进度、取消与结果。专用 Preload 桥使用 `webUtils.getPathForFile(file)` 取得真实磁盘路径，经窄类型 IPC 交给 Main 且不回传 Renderer；完整文件不得转成 ArrayBuffer 经 IPC。Main 使用当前 Session 从 Go 取得 Upload 授权和 active-user capability，验证可信顶层 Renderer、常规磁盘文件、HTTPS、Go 返回的精确 provider origin、PUT 与闭集签名请求头后，以 Electron `ClientRequest` 从磁盘流式上传并拒绝重定向。Main 不接受 Renderer 指定的任意路径、URL、方法或额外请求头；V1 不增加 Utility Process、自定义 protocol、multipart 或断点续传。
- finalize 先以短事务 CAS `pending -> verifying` 并取得 verification lease，再在事务外 HEAD 与完整有界 GET，复用内容 sniff、媒体 probe、实际 kind 限额和 SHA-256；最后在 verified write transaction 中原子创建 Reference Material 并标记 `finalized`。状态仅 `pending|verifying|finalized|terminal`；重复 finalize 返回同一素材，并发验证返回可重试安全码。
- image/audio/video 上限继续为 10/50/200 MiB。abort、过期、HEAD mismatch 与确定性媒体拒绝进入 terminal 并立即 best-effort DeleteObject；瞬时外部故障在 finalize window 内回到 pending。持久 cleanup worker 只按数据库记录的精确 key、verification lease 与 next-attempt 重试，不 List bucket；对象从一开始位于 `reference-materials/`，不 Copy，customer lifecycle 只作用于 `provider-transfer/`。
- signed PUT URL 只可在当前 Creator 对应的 Electron Main 上传操作内存中存在，Renderer 不接收；Provider Transfer Object GET URL 只可在 Go 到 AI Provider 的必要调用中存在；显示类 GET URL（缩略图与预览大图/媒体）可在当前已授权 Renderer 内存与 `<img>/<video>/<audio>` 加载请求中存在（Go 按素材 owner、Admin 的精确成品引用或有效 Team Publication 重新授权后签发，单一精确 key、约 10 分钟、图片带 provider 端缩小，元素 error 后重新授权）。三者均不进入本地持久化、普通日志、Audit Log、错误、剪贴板或遥测。Reference Material 本体下载仍经 Go 授权出口。

### Reference Material、共享对象与历史任务保留

- Generation Task 准入在创建不可变 Generation Specification 的同一短事务内，为其中每个素材 identity 写入权威 task-to-material 保留关系；不在读取时扫描 JSONB 推断对象生命周期，也不复制或持久化 signed URL。
- 既有任务的 Provider Reference Preparation 按其自身的保留关系读取冻结素材事实，不依赖 Composer 列表或 Session 活跃状态；移除素材不能撤销已准入任务的输入。
- `DELETE /creation/materials/{materialID}` 的业务语义是从该 User 的 Composer 移除一条素材记录：会话素材列表与后续任务准入只接受未移除记录。删除记录不等于删除其不可变存储对象；其他 User-owned 记录、Generation Task 保留关系或有效 Team Publication 仍引用同一对象时，不调度物理清理。
- material-id 显示 seam 可授权三类精确读取：当前 User 的活跃素材或其历史任务保留素材；Admin 经指定成功 Media Asset 查看该 Generation Specification 实际引用的素材；active User 查看有效 Team Publication 的素材快照。授权只覆盖被证明的记录和用途，不授予同 Session、同任务或同 object key 邻接内容的访问权。
- 发布在同一事务中为实际使用的每个 Reference Material 固定不可变对象引用、顺序、角色与声明版本；Create Similar 在 Publication 仍有效时为当前 User 新建独立素材记录并引用相同对象，不复制文件。撤回立即阻止新的 Publication 读取和复用，但既有 User-owned 记录与任务保留关系继续授权和保留对象。
- Reference Material 对象的物理清理条件是“没有任何 User-owned 素材记录、历史任务保留关系或有效 Team Publication 再引用该不可变对象”；Create Similar 已创建的素材记录与普通上传记录使用同一判断。触发变更必须在同一数据库事务中把精确对象 cleanup fact 置为 due，既有 cleanup worker 仍独占重试、确认和精确 key 删除；不建立通用 blob registry、跨业务引用计数服务，也不以单条素材记录的删除推断对象已失去全部引用。
- Generation Result、Media Asset 与 Team Publication 复用同一个不可覆盖的结果对象，不复制成品文件。不可变 Generation Task Result 或有效 Publication 任一仍引用时都保留对象；逻辑删除 Asset 只删除其读取入口，不直接触发结果对象清理。

### Creation domain-local 写事务

Creation 拥有自己的 domain-local write transaction implementation，与 Identity 的 Write Transaction Module 同纪律但不 deep-import 它，也不提前建立通用数据库框架：

- 直接以最小权限 `identity_app` LOGIN 角色运行；Module 构造时与每个写事务开始后验证 Authentication/Execution Identity（`session_user = current_user`），失败即回滚且不执行业务代码。
- 独占 begin/commit/rollback/cancel/panic 与 AfterCommit effect；外部 Provider/Storage 调用永不发生在持锁事务内。

### 共享 Audit Append

通用审计写入是共享深 Module（Audit Append，语义见 [ADR-0009](0009-audit-log-snapshot-and-immutability.md)）：Creation 在自己的业务事务内 append actor/target 快照、合法 action 与脱敏 metadata，append 失败回滚业务写；Identity 保留 Admin Audit Log 查询 surface。审计行不可 UPDATE，保留 365 天。

### Session 吊销后断流

Identity 在 Session 吊销事务成功提交后，通过共享 Domain Event（`internal/event`）发布受影响的非敏感 Session identity；Creation 的 SSE hub 订阅并断开精确流。回滚不发布；已授权的在途 HTTP 请求不追溯取消；事件只表达事实，不携带 token、prompt 或私有内容。

### Generation Task 详情读取合同

先保证单个 Generation Task 的状态、结果位、诊断/结果与 Generation Specification 来自一致读取，不能把并发提交前后的数据混成一份详情。再验证能否复用 `updatedAt` 作为增量补读的变化判据：传输须保留足够精度，而且每次可见详情变化都必须改变它；保证覆盖相关写入路径、列表/详情语义与并发读取，不能只依赖调用习惯或时间格式调整。

经 #190 的生产写入口审计，外部可见的可变详情只来自 task transition、cancel request 与 write-once slot verdict；Generation Specification 在准入后不可变，provider job、queue、reservation 与 asset 的内部变化不直接进入详情。因此采用以下已实现保证：

- creator detail 在只读 `REPEATABLE READ` 事务中读取 task、slots 与 job，使返回的 `updatedAt` 和全部详情事实属于同一数据库快照；列表摘要由单条查询读取同一 task 行判据。
- task transition 与首次 cancel request 在同一写语句中以 `GREATEST(updated_at + interval '1 microsecond', clock_timestamp())` 严格推进父 task 判据；重复 cancel 不制造无事实变化的新判据。
- `WriteSlotVerdict` 先锁 parent task，再写 slot，并且只在首次 verdict 成功时于同一 verified write transaction 推进父 task 判据。这个局部 `task → slot` 顺序不新增 slot/task 反向锁序；它不宣称修复 Creation worker 中既有的其他锁序风险。
- HTTP 以 RFC 3339 fractional-second 形式保留 PostgreSQL 的微秒值；列表与详情的 `updated_at` 具有相同语义，Desktop 将完整字符串视为 opaque criterion，不经毫秒级 `Date` 转换后比较。
- fresh submit/retry 返回数据库生成的时间；idempotent replay 的响应同时采用 post-commit 重读的 task 与 slots，避免响应层重新拼接不同快照。

受控测试覆盖 task/slot 并发提交时的单快照、同秒连续及并发 slot 写入、status/cancel/diagnostic/result 的判据推进、列表/详情 wire 精度和 Desktop 详情整卡配对。PostgreSQL `timestamptz` 的微秒精度与上述严格推进机制足以区分每次可见提交，所以 `revision` 不提供额外保证，只会扩大 schema 与消费者变更；本修订不新增列或数据迁移。

该判据仅适用于 Generation Task 的一致详情，不是跨 aggregate 的全局事件序号。详情返回的判据必须对应同一份一致读取结果。这项 Go 合同是 Desktop 任务增量刷新的独立前置，客户端调度、缓存与展示生命周期见 [Desktop ADR-0005](../../apps/desktop/docs/adr/0005-creation-operation-and-task-refresh-lifetimes.md)，不混入服务端可信责任。

### 本地 AEAD（Creation 外部连接凭据保护）

- AI Provider Key 与 Object Storage AK/SK 以应用层 AEAD envelope 存入 PostgreSQL：数据库外 secrets volume（目录 0700、文件 0600、原子创建）保存共享的 32-byte CSPRNG Creation Credential Master Key；AES-256-GCM + 每次随机 nonce；版本化 envelope 保存 key ID、nonce、ciphertext，AAD 分别绑定 Connection ID、provider、凭据用途与 envelope version。
- master key 权限过宽、损坏、不可读或解密失败时对应 Connection 进入 `credential_unavailable` 并 fail closed，Server 其他业务继续运行；已有密文时绝不静默生成替代 key。首个显式恢复命令经 Admin exact-action Reauthentication 后安全建立新 master key 并写入该次重输凭据；其他旧 envelope 保持 unavailable，等待分别恢复。任一步失败不激活候选且可重试；客户有完整备份时优先恢复原 key 文件。
- 凭据明文只在 Go 检查或调用期间短暂存在于内存；Key、prompt、私有媒体、Authorization header、上述窄例外以外的可访问 URL 与任意原始 response body 不进入 Desktop、普通日志、Audit Log 或错误响应。Generation Task/Result Slot 已是 creator-private，因此失败结果位可持久化并向该任务创建者返回 Kapon 标准错误 envelope 中有界的 `code`、`type`、`message`、`request_id`，以及 Server 后处理阶段生成的明确安全诊断；可信适配器先对本次凭据、Authorization 形态、提交 body 中的 prompt/reference 与 URL/data URL 模式做脱敏，再丢弃控制字符、超长值和 envelope 外字段。稳定 Failure Reason 继续承担状态机、重试与治理判断，诊断对象只解释该 verdict，不参与控制流。首个稳定映射仍为 Kapon `MODEL_GROUP_ALL_UNAVAILABLE` → `provider_route_unavailable`，用于区分模型渠道不可用与一般临时故障；若同一响应携带标准错误 envelope，Desktop 同时显示其具体字段。Connection 管理面、普通日志和 Audit Log 仍不返回这些 creator-private 诊断。
- **2026-09-01 后续决定（供应商拒绝诊断）**：供应商返回非 2xx 或传输失败时，可信适配器把本次出站请求的**形状摘要**（`model`/`size`/`watermark` 等参数键值，prompt、reference、URL 一律替换为 `[redacted]`，有界截断）追加到该失败诊断 message，并以同一摘要写一条 Server 本地 slog WARN——普通日志因此只出现脱敏后的请求形状，不含上段列举的任何敏感值。这让「供应商为什么拒绝」可以在不接触 payload 的情况下被诊断（字段报告 2026-09-01：未记录的 `n` 参数导致 invalid_request_error 400）。

### Capability Manifest 与 Provider 验证

- AI Provider Capability Manifest 是随 Nevix 代码发布的版本化合同：模型、模式、参数与参考素材限制只有在开发者确认供应商合同并更新实现、契约和测试后才进入版本。Desktop 镜像允许值，Server 仍执行权威准入校验。
- 实例运行时只把 AI Provider Connection Check 作为媒体可用性输入：Token、固定模型可见性或管理状态不满足时，仅对应 Creation 媒体 fail closed；这些事实不影响 Server 启动和其他业务。
- fake adapter 与契约测试进入普通 CI。首次正式发布、固定模型变化或供应商合同变化时，开发者按发布 checklist 人工执行真实 Kapon generation smoke，并把结果记入 release checklist 或 issue；该记录不是部署资产，不进入 Server 配置，不控制 Capability Manifest，也不要求重启 Server 激活。
- 用户真实生成失败只使对应 Generation Task/Result Slot 进入明确失败或重试语义；不得因为外部 Provider 一次失败而终止 Server 进程。

### 官方公网交付责任

Go 唯一可信数据面与桌面端连接规则归 [ADR-0014](0014-go-sole-trusted-data-plane.md)；官方公网 Compose、证书生命周期与备份范围的权威说明归 [ADR-0013](0013-onprem-single-tenant-delivery.md)。交付资产 canonical owner：官方公网 Compose、Nginx 配置、证书初始化与部署手册归 `deploy/`，备份与恢复脚本及手册归 `scripts/`（目录契约见根 `README.md`）。

## Considered Options

- **按规格逐票实施、不改架构文档**：旧 ADR 与最终基线冲突（团队共享可读、RFC1918 http、Organization Publication），实施 agent 会沿冲突文档复活旧设计；否决，先做本文档 prefactor。
- **把全部 seam 并入 ADR-0014/0015**：两份 ADR 的主题分别是数据面与用户系统；可见性、写事务、AEAD、断流是 Creation 侧职责，混入会破坏各自单一主题；否决。
- **Identity 写事务 Module 直接复用为共享框架**：deep-import 破坏 Module 边界，且无第二个 consumer 之前建通用数据库框架属过早抽象；否决，Creation 建同纪律的 domain-local 实现。
- **外部 Secret Store（Vault 等）**：私有化交付新增外部依赖与运维面；本地 AEAD + 数据库外主密钥已覆盖威胁模型（数据库/备份泄露不直接暴露可用 Key）；否决。
- **Production Readiness evidence 作为运行时能力门禁**：把发布检查结果复制到每个 Deployment Instance，再由 Server 在启动时解析其 schema，会把发布审计、部署配置和运行时可用性耦合；文件漂移还能阻止整个数据面启动，而普通测试、Connection Check 和发布前 smoke 已分别覆盖开发、实例配置与发布风险。否决。
- **把永久素材直传做成通用 Storage Grant、multipart 或断点续传**（2026-09-08）：V1 已有明确 10/50/200 MiB 上限，单次 PUT 足够；扩大到任意 key/method、分片状态或恢复协议会放大授权、传输状态、清理和兼容面。否决，只保留单对象、短时、禁止覆盖且必须 Go finalize 的 Upload。
- **pending prefix 后 Copy 到永久 key**（2026-09-08）：需要额外 Copy 权限、供应商差异和双份对象流量，只为获得 prefix lifecycle；持久上传租约和精确 Delete 已提供清理真相。否决，直接写随机最终 key。

## 后果

- 实施切片以本 ADR 为架构入口：与最终基线冲突的旧表述以本 ADR 与所引修订为准。
- 后续切片如需改变本 ADR 记录的 seam，先修订本 ADR 或其指向的权威 ADR，再实施。
- 仓库目录契约在根 `README.md` 命名 `deploy/` 与 `scripts/` 的交付资产归属；公网交付切片不得临时新建顶层 source owner。
- 部署不再包含 Production Readiness evidence 文件、环境变量、secrets volume 路径或复制后重启步骤；旧文件即使仍留在主机也不被 Server 读取。
- Object Storage 与 Reference Material Upload 落地前必须同步修订 OpenAPI、Desktop 原生上传/恢复、真实 OSS/COS smoke 与交付清单；filesystem/通用 S3 产品路径和原 multipart 上传不保留兼容层。
- [#215](https://github.com/wsgbwps/nevix-ai/issues/215) 的全部实施切片与验收条件完成前，不开始 [#214](https://github.com/wsgbwps/nevix-ai/issues/214) 的 Provider Transfer Object 与两阶段 Provider 提交实现；本次架构 prefactor 本身不解除该阻塞。

## 非目标

- 本 ADR 不定义 creation OpenAPI 形状、生成状态机、治理计数与 UI 合同；这些归 [#150](https://github.com/wsgbwps/nevix-ai/issues/150) 的对应实施切片。
