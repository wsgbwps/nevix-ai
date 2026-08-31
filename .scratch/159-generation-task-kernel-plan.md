# 高风险计划：AI Creation V1 09/16 — Generation Task 内核与用量治理（issue #159）

Primary Domain：AI Creation（canonical owner `creation`）。涉及 public contract（root `contracts/`）、
持久数据与 migration、治理（授权相关计数）、SSE 共享 seam（`internal/event`）——按 AGENTS.md 在编码前落计划。

## 范围（对照 #159 验收）

1. 幂等提交：`POST /creation/sessions/{sessionID}/tasks`，creator-scoped `idempotency_key`；
   同 key 同规范化 payload 返回既有 Task（200），同 key 不同 payload 409 `idempotency_payload_conflict`；
   重试不重复计 attempt/月计数/reservation。
2. 提交冻结：从**服务器端存储的 draft** 构造不可变 Generation Specification（jsonb，schema_version）；
   请求携带 `draft_revision`（draft_updated_at），准入边界复验 revision、manifest version、
   Reference identity/role/kind、参数对当前 manifest 的合规性；过期/不合法草稿不创建 Task，不改写草稿。
3. 原子准入（一个 writetx 短事务）：结构有效 attempt 行 + 治理检查（固定顺序）+ 不可变 spec、
   Task、N 个稳定有序 slot、首个 pending Provider Job、queue item、分媒体 concurrency reservation。
   治理拒绝只持久化 attempt 行；基础设施错误整体回滚。
4. 状态机（domain 纯函数 + SQL 迁移守卫）：Task queued→submitting→(processing 可跳过)→persisting→终态，
   cancelling 分支；Job pending/submitting/processing/cancelling + 终态（completed/failed/cancelled/
   timed_out/indeterminate）；slot 终态 succeeded/failed/cancelled/timed_out/indeterminate；
   终态永不重开、内部 retry 不回 queued、indeterminate 永不自动 retry。
5. 队列 worker：PostgreSQL queue，`FOR UPDATE SKIP LOCKED` claim、短 lease（30s）、有界 attempts、
   稳定锁顺序（queue→task→job→slot）；外部 Provider/Storage 调用一律不在持锁事务内。
   lease 过期/worker crash/本地 timeout 不产生业务 timed_out，只重新 claim / 有界重试 / 告警日志。
6. Provider gateway port（domain）+ Kapon generations adapter（image 同步 /v1/images/generations、
   video 异步 /v1/contents/generations/tasks）；输出 URL 转存自有 Storage（≤1 GiB 上限）+
   media.Prober 校验（MIME/checksum/宽高/时长）→ slot 终态与 Generation Result。
   402 → 连接级持久 credit_blocked（DB 列）+ Admin 手动清除端点；429 → Retry-After /
   5s/15s/30s/60s 抖动退避（内存）；503 → 连接×媒体 30s/1m/2m/5m 冷却（内存）+
   10 分钟 3 次运营告警日志。
7. 治理：`creation_generation_policies`（scope=instance|user；并发分图片/视频池、滚动 60s 频率、
   Asia/Shanghai 自然月 Task；未设置=不限、显式 0=禁止）。固定阻止顺序
   provider_credit → instance monthly → member monthly → instance rate → member rate →
   member media concurrency，machine reasons 固定八字表。月计数=已准入 Task 数；
   频率=结构有效尝试数（含被其他治理规则拒绝的）。
8. reservation 与 Task 同事务创建，Task 首次进入任一终态时同事务 `released_at` 恰好置位一次
   （`WHERE released_at IS NULL` 守卫 + 释放行数即释放事实）。
9. Connection 治理：存在非终态 Task/Job 时 DELETE 返回 409 `active_generation_tasks_exist`；
   paused 阻止新 Task（admission）与未开始调用（worker hold），已接受 Job 继续收敛。
10. SSE：`GET /creation/events`（fetch-stream、Authorization header、~20s heartbeat、无 Last-Event-ID）。
    持久状态 commit 后经 `AfterCommit` → `internal/event` bus（新增类型，共享区）→ hub 定向
    creator；断流客户端 refetch → 重连 → SSE 断开期间 5s polling，10 秒内收敛。
11. Workbench：四列直角 slot 画廊（queued/generating/persisting/成功/部分成功/稳定失败嵌在 slot 内），
    cancel、再次生成（新 key 新 Task）、只重试未完成项（新 key 新 Task、数量=未完成槽位）、
    indeterminate 显式风险确认后重做。提交按钮激活；素材经 creator 私有下载端点展示。

## 明确不做（切片边界）

- `media_assets` 聚合、Asset Library、Publication（切片 10–12）；本切片 slot 成功结果为
  Task 拥有的私有 Generation Result（转存 blob + 事实），供 creator 下载/预览。
- Admin 治理配置的 Desktop UI（验收只要求 Server 治理行为 + 配置 API）。
- Electron smoke 扩展（现有 smoke 必须继续通过；task 生命周期由组件测试 + 真库 contract 测试覆盖）。
- 真实 Kapon 调用（fake/recorded adapter 测试；真实 smoke 属 release gate）。

## 数据形状（migration 0008，up-only）

`creation_generation_tasks`（UNIQUE(owner,idempotency_key)；spec jsonb；status CHECK 八+五态；
cancel_requested_at；draft_revision）· `creation_generation_slots`（UNIQUE(task,slot_index)；
终态列 + result 事实列）· `creation_provider_jobs`（partial UNIQUE(task) WHERE 非终态）·
`creation_generation_queue`（UNIQUE(task)；run_after/lease_until/attempts）·
`creation_generation_reservations`（UNIQUE(task)；released_at partial index 计数）·
`creation_generation_attempts`（identity bigint；attempted_at 索引，滚动窗口计数+清理）·
`creation_generation_policies`（UNIQUE(scope, COALESCE(user_id,uuid0))）·
`provider_connections.credit_blocked_at` 列。全部 FK 带索引；identity_app GRANT SELECT/INSERT/UPDATE。

## 授权 / 安全要点

- 所有新路由 RequireActiveUser（creator-private）或 RequireAdmin（治理配置、credit 清除）。
- Task/Result 只创建者可读；下载端点走既有 Go 有界流式 seam，不暴露 Storage 凭据。
- Provider 原始错误/request ID/prompt 不进日志与响应；reason 全部映射稳定 taxonomy。
- SSE payload 只含失效事实（无 prompt/媒体/私有内容）。

## 验证门槛

- `make test-creation-integration` 零 skip：admission 原子性、幂等、治理矩阵与顺序、
  reservation 恰好释放一次、SKIP LOCKED claim/lease 恢复、SSE commit-before-notify、p95≤1s、
  OpenAPI conformance。
- Domain property 测试：状态矩阵、终态聚合、slot 稳定序。
- Desktop 组件测试：slot 状态/操作/indeterminate 确认/SSE 丢失轮询。
- 960×600 与 1280×800 对照 pinned 6e465e8（PR 链接基线并列出有意偏差）。

## 拆分提交（同分支，最终单 PR）

migration+domain → contract → server repos/services → worker/gateway/SSE/HTTP → server tests →
desktop → 原型对比与 QA 勾选。
