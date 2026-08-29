-- Generation Task 内核与用量治理的持久基座（AI Creation V1 切片 09，issue #159）。
-- 一次成功提交在一个短事务内原子创建：不可变 Generation Specification（jsonb，schema version）、
-- Generation Task、N 个稳定有序 slot、首个 pending Provider Job、持久 queue item 和
-- 分媒体 concurrency reservation；预期治理拒绝只提交本次结构有效尝试事实。
-- 状态机为单向迁移（规格 #150）：终态永不重开、内部 retry 不回 queued、indeterminate 永不自动
-- retry，数据库 CHECK 与部分唯一索引是 durable twin。reservation 在 Task 首次进入任一终态时
-- 恰好释放一次（released_at 由 WHERE 守卫置位一次）。治理 policy 支持未设置（不限）与显式 0
-- （禁止）；频率为滚动 60 秒结构有效尝试、月 Task 为 Asia/Shanghai 自然月、并发按图片/视频分池。
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

CREATE TABLE public.creation_generation_tasks (
  id                  uuid                     NOT NULL DEFAULT gen_random_uuid(),
  session_id          uuid                     NOT NULL,
  owner_user_id       uuid                     NOT NULL,
  idempotency_key     text                     NOT NULL,
  payload_hash        text                     NOT NULL,
  media_type          text                     NOT NULL,
  specification       jsonb                    NOT NULL,
  manifest_version    integer                  NOT NULL,
  draft_revision      timestamp with time zone NOT NULL,
  status              text                     NOT NULL DEFAULT 'queued',
  slot_count          integer                  NOT NULL,
  terminal_cause      text,
  cancel_requested_at timestamp with time zone,
  created_at          timestamp with time zone NOT NULL DEFAULT now(),
  updated_at          timestamp with time zone NOT NULL DEFAULT now(),
  terminal_at         timestamp with time zone,
  CONSTRAINT creation_generation_tasks_pkey PRIMARY KEY (id),
  -- creator-scoped 幂等：同 key 重放命中本约束；payload 冲突由命令层比较 payload_hash。
  CONSTRAINT creation_generation_tasks_owner_key_unique UNIQUE (owner_user_id, idempotency_key),
  CONSTRAINT creation_generation_tasks_media_check CHECK (media_type = ANY (ARRAY['image'::text, 'video'::text])),
  CONSTRAINT creation_generation_tasks_status_check CHECK (status = ANY (ARRAY[
    'queued'::text, 'submitting'::text, 'processing'::text, 'persisting'::text, 'cancelling'::text,
    'succeeded'::text, 'partially_succeeded'::text, 'failed'::text, 'cancelled'::text, 'timed_out'::text
  ])),
  CONSTRAINT creation_generation_tasks_slot_count_check CHECK (slot_count >= 1 AND slot_count <= 4),
  CONSTRAINT creation_generation_tasks_terminal_cause_check CHECK (
    terminal_cause IS NULL OR terminal_cause = 'provider_outcome_indeterminate'::text
  ),
  -- 终态行必须有终结时间；非终态行必须没有，终态永不重开。
  CONSTRAINT creation_generation_tasks_terminal_pairing_check CHECK (
    (status = ANY (ARRAY['succeeded'::text, 'partially_succeeded'::text, 'failed'::text, 'cancelled'::text, 'timed_out'::text])) = (terminal_at IS NOT NULL)
  ),
  CONSTRAINT creation_generation_tasks_idempotency_key_check CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  CONSTRAINT creation_generation_tasks_session_fk FOREIGN KEY (session_id) REFERENCES public.creation_sessions (id),
  CONSTRAINT creation_generation_tasks_owner_fk FOREIGN KEY (owner_user_id) REFERENCES public.users (id)
);

CREATE INDEX creation_generation_tasks_owner_created_idx
  ON public.creation_generation_tasks (owner_user_id, created_at DESC, id DESC);
CREATE INDEX creation_generation_tasks_session_created_idx
  ON public.creation_generation_tasks (session_id, created_at DESC, id DESC);
-- 月治理计数按 (owner, created_at) 与实例级 (created_at) 走索引。
CREATE INDEX creation_generation_tasks_created_idx
  ON public.creation_generation_tasks (created_at);
-- 连接删除守卫与 worker 巡检的谓词与索引同形：非终态集合。
CREATE INDEX creation_generation_tasks_nonterminal_idx
  ON public.creation_generation_tasks (created_at)
  WHERE status = ANY (ARRAY['queued'::text, 'submitting'::text, 'processing'::text, 'persisting'::text, 'cancelling'::text]);

CREATE TABLE public.creation_generation_slots (
  task_id             uuid    NOT NULL,
  slot_index          integer NOT NULL,
  -- NULL = 仍为 task/job/queue 的派生投影；终态写入一次，永不改写。
  status              text,
  failure_reason      text,
  result_mime         text,
  result_byte_size    bigint,
  result_checksum     bytea,
  result_blob_key     text,
  result_width_px     integer,
  result_height_px    integer,
  result_duration_ms  integer,
  CONSTRAINT creation_generation_slots_pkey PRIMARY KEY (task_id, slot_index),
  CONSTRAINT creation_generation_slots_status_check CHECK (
    status IS NULL OR status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text, 'timed_out'::text, 'indeterminate'::text])
  ),
  -- 稳定失败 taxonomy 的八字表（规格 #150）。
  CONSTRAINT creation_generation_slots_reason_check CHECK (
    failure_reason IS NULL OR failure_reason = ANY (ARRAY[
      'invalid_input'::text, 'rights_confirmation_required'::text, 'input_policy_rejected'::text,
      'output_policy_rejected'::text, 'action_required'::text, 'temporarily_unavailable'::text,
      'processing_indeterminate'::text, 'internal_error'::text
    ])
  ),
  -- 结果事实只属于成功槽位。
  CONSTRAINT creation_generation_slots_result_pairing_check CHECK (
    (status = 'succeeded'::text) = (result_blob_key IS NOT NULL)
  ),
  CONSTRAINT creation_generation_slots_task_fk FOREIGN KEY (task_id) REFERENCES public.creation_generation_tasks (id) ON DELETE CASCADE
);

CREATE TABLE public.creation_provider_jobs (
  id           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  task_id      uuid                     NOT NULL,
  media_type   text                     NOT NULL,
  status       text                     NOT NULL DEFAULT 'pending',
  external_ref text,
  -- 提交结局标记：transient_rejected = 上次提交收到明确的暂时拒绝（429/503，
  -- 外部未执行，可安全重试）；NULL = 结局已收敛或尚未识别。用于区分
  -- "可重试的已识别拒绝"与"必须收敛为 indeterminate 的未识别提交"。
  last_outcome text,
  created_at   timestamp with time zone NOT NULL DEFAULT now(),
  updated_at   timestamp with time zone NOT NULL DEFAULT now(),
  terminal_at  timestamp with time zone,
  CONSTRAINT creation_provider_jobs_pkey PRIMARY KEY (id),
  CONSTRAINT creation_provider_jobs_task_fk FOREIGN KEY (task_id) REFERENCES public.creation_generation_tasks (id) ON DELETE CASCADE,
  CONSTRAINT creation_provider_jobs_media_check CHECK (media_type = ANY (ARRAY['image'::text, 'video'::text])),
  CONSTRAINT creation_provider_jobs_status_check CHECK (status = ANY (ARRAY[
    'pending'::text, 'submitting'::text, 'processing'::text, 'cancelling'::text,
    'completed'::text, 'failed'::text, 'cancelled'::text, 'timed_out'::text, 'indeterminate'::text
  ])),
  CONSTRAINT creation_provider_jobs_terminal_pairing_check CHECK (
    (status = ANY (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text, 'timed_out'::text, 'indeterminate'::text])) = (terminal_at IS NOT NULL)
  ),
  CONSTRAINT creation_provider_jobs_last_outcome_check CHECK (
    last_outcome IS NULL OR last_outcome = 'transient_rejected'::text
  )
);

-- 一个 Task 至多一个未结算 Job；每次外部尝试的收敛都在该 Job 上记录。
CREATE UNIQUE INDEX creation_provider_jobs_active_idx
  ON public.creation_provider_jobs (task_id)
  WHERE status = ANY (ARRAY['pending'::text, 'submitting'::text, 'processing'::text, 'cancelling'::text]);

CREATE TABLE public.creation_generation_queue (
  id           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  task_id      uuid                     NOT NULL,
  media_type   text                     NOT NULL,
  run_after    timestamp with time zone NOT NULL DEFAULT now(),
  lease_owner  text,
  lease_until  timestamp with time zone,
  attempts     integer                  NOT NULL DEFAULT 0,
  max_attempts integer                  NOT NULL DEFAULT 240,
  created_at   timestamp with time zone NOT NULL DEFAULT now(),
  updated_at   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT creation_generation_queue_pkey PRIMARY KEY (id),
  CONSTRAINT creation_generation_queue_task_unique UNIQUE (task_id),
  CONSTRAINT creation_generation_queue_task_fk FOREIGN KEY (task_id) REFERENCES public.creation_generation_tasks (id) ON DELETE CASCADE,
  CONSTRAINT creation_generation_queue_media_check CHECK (media_type = ANY (ARRAY['image'::text, 'video'::text])),
  CONSTRAINT creation_generation_queue_attempts_check CHECK (attempts >= 0 AND max_attempts > 0)
);

-- claim 按 (run_after, id) 唤醒到期项；租约判断在查询谓词中（now() 不可进索引谓词）。
CREATE INDEX creation_generation_queue_claim_idx
  ON public.creation_generation_queue (run_after, id);

CREATE TABLE public.creation_generation_reservations (
  id            uuid                     NOT NULL DEFAULT gen_random_uuid(),
  task_id       uuid                     NOT NULL,
  owner_user_id uuid                     NOT NULL,
  media_type    text                     NOT NULL,
  created_at    timestamp with time zone NOT NULL DEFAULT now(),
  released_at   timestamp with time zone,
  CONSTRAINT creation_generation_reservations_pkey PRIMARY KEY (id),
  CONSTRAINT creation_generation_reservations_task_unique UNIQUE (task_id),
  CONSTRAINT creation_generation_reservations_task_fk FOREIGN KEY (task_id) REFERENCES public.creation_generation_tasks (id) ON DELETE CASCADE,
  CONSTRAINT creation_generation_reservations_owner_fk FOREIGN KEY (owner_user_id) REFERENCES public.users (id),
  CONSTRAINT creation_generation_reservations_media_check CHECK (media_type = ANY (ARRAY['image'::text, 'video'::text]))
);

-- 并发计数与真实谓词同形：active reservation 按 (owner, media) 分池。
CREATE INDEX creation_generation_reservations_active_idx
  ON public.creation_generation_reservations (owner_user_id, media_type)
  WHERE released_at IS NULL;

-- 结构有效尝试的滚动窗口计数（含被其他治理规则拒绝的提交）；窗口外行在准入事务内机会性清理。
CREATE TABLE public.creation_generation_attempts (
  id           bigint                   NOT NULL GENERATED ALWAYS AS IDENTITY,
  user_id      uuid                     NOT NULL,
  attempted_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT creation_generation_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT creation_generation_attempts_user_fk FOREIGN KEY (user_id) REFERENCES public.users (id)
);

CREATE INDEX creation_generation_attempts_user_time_idx
  ON public.creation_generation_attempts (user_id, attempted_at DESC);
CREATE INDEX creation_generation_attempts_time_idx
  ON public.creation_generation_attempts (attempted_at);

-- 治理 policy：instance 一行（user_id IS NULL）+ 任意 active User 的覆盖行。
-- 未设置列 = 不限；显式 0 = 禁止相应范围的新 Task。
CREATE TABLE public.creation_generation_policies (
  id                  uuid                     NOT NULL DEFAULT gen_random_uuid(),
  scope               text                     NOT NULL,
  user_id             uuid,
  image_concurrency   integer,
  video_concurrency   integer,
  rate_limit          integer,
  monthly_task_limit  integer,
  updated_by_user_id  uuid                     NOT NULL,
  updated_at          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT creation_generation_policies_pkey PRIMARY KEY (id),
  CONSTRAINT creation_generation_policies_scope_check CHECK (scope = ANY (ARRAY['instance'::text, 'user'::text])),
  CONSTRAINT creation_generation_policies_user_pairing_check CHECK (
    (scope = 'instance'::text AND user_id IS NULL) OR (scope = 'user'::text AND user_id IS NOT NULL)
  ),
  CONSTRAINT creation_generation_policies_nonnegative_check CHECK (
    (image_concurrency IS NULL OR image_concurrency >= 0)
    AND (video_concurrency IS NULL OR video_concurrency >= 0)
    AND (rate_limit IS NULL OR rate_limit >= 0)
    AND (monthly_task_limit IS NULL OR monthly_task_limit >= 0)
  ),
  CONSTRAINT creation_generation_policies_user_fk FOREIGN KEY (user_id) REFERENCES public.users (id),
  CONSTRAINT creation_generation_policies_updated_by_fk FOREIGN KEY (updated_by_user_id) REFERENCES public.users (id)
);

-- instance policy 至多一行；user policy 每 user 至多一行（NULL 在唯一索引中互不相等，
-- 故以 COALESCE 哨兵收敛）。
CREATE UNIQUE INDEX creation_generation_policies_singleton_idx
  ON public.creation_generation_policies ((1))
  WHERE scope = 'instance'::text;
CREATE UNIQUE INDEX creation_generation_policies_user_unique_idx
  ON public.creation_generation_policies (COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX creation_generation_policies_user_fk_idx
  ON public.creation_generation_policies (user_id);

-- Provider 402 的连接级持久额度阻止：跨进程事实存库，Admin 手动清除。
ALTER TABLE public.provider_connections
  ADD COLUMN credit_blocked_at timestamp with time zone;

-- Task/Job 写路径是 UPDATE 语义，identity_app 不获得 DELETE 权限。
GRANT SELECT, INSERT, UPDATE ON public.creation_generation_tasks TO identity_app;
GRANT SELECT, INSERT, UPDATE ON public.creation_generation_slots TO identity_app;
GRANT SELECT, INSERT, UPDATE ON public.creation_provider_jobs TO identity_app;
GRANT SELECT, INSERT, UPDATE ON public.creation_generation_queue TO identity_app;
GRANT SELECT, INSERT, UPDATE ON public.creation_generation_reservations TO identity_app;
-- attempts 使用 IDENTITY，允许 INSERT/SELECT；不授予 UPDATE。
GRANT SELECT, INSERT ON public.creation_generation_attempts TO identity_app;
GRANT SELECT, INSERT, UPDATE ON public.creation_generation_policies TO identity_app;
GRANT UPDATE ON public.provider_connections TO identity_app;
