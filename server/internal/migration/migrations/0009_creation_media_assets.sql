-- 图片/视频输出的 Media Asset 聚合基座(AI Creation V1 切片 10,issue #160)。
-- 每个 Provider 输出经有界流式转存并通过 MIME/checksum/实际尺寸/大小验证后,
-- 才在转存事务内为对应 slot 恰好形成一行不可变 Media Asset;UNIQUE(task_id, slot_index)
-- 是"每 slot 至多一个 Asset、重复 poll/worker 完成/崩溃恢复转存不重复建 Asset"的 durable twin
-- (规格 #150 Asset 唯一性)。Asset 与来源 Session/Task 的生命周期彼此独立:无级联删除,
-- 行内快照 owner 供切片 12 的 Team-readable 查询使用;事实列不可变,仅授予 SELECT/INSERT。
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

CREATE TABLE public.creation_media_assets (
  id          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  owner_user_id uuid                   NOT NULL,
  task_id     uuid                     NOT NULL,
  slot_index  integer                  NOT NULL,
  media_type  text                     NOT NULL,
  mime        text                     NOT NULL,
  blob_key    text                     NOT NULL,
  byte_size   bigint                   NOT NULL,
  checksum    bytea                    NOT NULL,
  width_px    integer,
  height_px   integer,
  duration_ms integer,
  created_at  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT creation_media_assets_pkey PRIMARY KEY (id),
  -- 每个 slot 至多一个 Asset;插入侧 ON CONFLICT DO NOTHING 依赖本约束。
  CONSTRAINT creation_media_assets_task_slot_unique UNIQUE (task_id, slot_index),
  CONSTRAINT creation_media_assets_media_check CHECK (media_type = ANY (ARRAY['image'::text, 'video'::text])),
  CONSTRAINT creation_media_assets_slot_index_check CHECK (slot_index >= 0 AND slot_index < 4),
  CONSTRAINT creation_media_assets_size_check CHECK (byte_size > 0 AND byte_size <= 1073741824),
  CONSTRAINT creation_media_assets_owner_fk FOREIGN KEY (owner_user_id) REFERENCES public.users (id),
  CONSTRAINT creation_media_assets_task_fk FOREIGN KEY (task_id) REFERENCES public.creation_generation_tasks (id)
);

-- (task_id, slot_index) 唯一索引即 task 外键的匹配索引;owner 外键按仓库约定补索引。
CREATE INDEX creation_media_assets_owner_idx
  ON public.creation_media_assets (owner_user_id);

GRANT SELECT, INSERT ON public.creation_media_assets TO identity_app;
