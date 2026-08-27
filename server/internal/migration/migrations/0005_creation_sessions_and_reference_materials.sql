-- Creation Session 与 Reference Material 的持久基座（AI Creation V1 切片 06，issue #156）。
-- 可见性基线是 creator-private（ADR-0016）：行级所有权由 owner_user_id 表达，
-- Server 查询层与命令层都在 Go 中执行该规则；不创建任何 RLS 或第二数据库角色
-- （ADR-0014/0015）。删除会话是逻辑删除：deleted_at 置位后查询层立即隐藏并阻止
-- 后续生成入口；素材行与其 blob 随会话语义保留，媒体资产生命周期独立。
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

CREATE TABLE public.creation_sessions (
  id            uuid                     NOT NULL DEFAULT gen_random_uuid(),
  owner_user_id uuid                     NOT NULL,
  name          text                     NOT NULL DEFAULT '',
  created_at    timestamp with time zone NOT NULL DEFAULT now(),
  updated_at    timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at    timestamp with time zone,
  CONSTRAINT creation_sessions_pkey PRIMARY KEY (id),
  -- 空名是有意决策：界面以本地化「未命名创作」兜底展示。
  CONSTRAINT creation_sessions_name_len_check CHECK (char_length(name) <= 128),
  CONSTRAINT creation_sessions_owner_fk FOREIGN KEY (owner_user_id) REFERENCES public.users (id)
);

CREATE TABLE public.creation_reference_materials (
  id              uuid                     NOT NULL DEFAULT gen_random_uuid(),
  session_id      uuid                     NOT NULL,
  kind            text                     NOT NULL,
  file_name       text                     NOT NULL,
  mime_type       text                     NOT NULL,
  byte_size       bigint                   NOT NULL,
  checksum_sha256 bytea                    NOT NULL,
  blob_key        text                     NOT NULL,
  width_px        integer,
  height_px       integer,
  pixel_count     bigint,
  duration_ms     integer,
  claims_version  integer                  NOT NULL DEFAULT 1,
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT creation_reference_materials_pkey PRIMARY KEY (id),
  -- 上限取图片/视频两合同中较宽的入料值；生成期包络在提交时按 manifest 校验。
  CONSTRAINT creation_reference_materials_size_check CHECK (byte_size > 0 AND byte_size <= 209715200),
  CONSTRAINT creation_reference_materials_claims_version_check CHECK (claims_version >= 1),
  CONSTRAINT creation_reference_materials_duration_ms_check CHECK (duration_ms IS NULL OR duration_ms > 0),
  CONSTRAINT creation_reference_materials_file_name_len_check CHECK (char_length(file_name) <= 255),
  CONSTRAINT creation_reference_materials_kind_check CHECK (kind = ANY (ARRAY['image'::text, 'video'::text, 'audio'::text])),
  -- kind 决定哪些探测事实必须存在：图像必须有尺寸与像素数（且像素数等于宽×高）且无时长，
  -- 视频有正尺寸与时长且无像素数，音频只有正时长。数据库层固定一致性，
  -- 服务端写入前已完成权威验证。
  CONSTRAINT creation_reference_materials_kind_facts_check CHECK (
    (kind = 'image' AND width_px > 0 AND height_px > 0 AND pixel_count = width_px::bigint * height_px AND duration_ms IS NULL)
    OR (kind = 'video' AND width_px > 0 AND height_px > 0 AND duration_ms > 0 AND pixel_count IS NULL)
    OR (kind = 'audio' AND width_px IS NULL AND height_px IS NULL AND pixel_count IS NULL AND duration_ms > 0)
  ),
  -- blob 键全局唯一：素材 identity 到 Storage 对象的一对一映射。
  CONSTRAINT creation_reference_materials_blob_key_key UNIQUE (blob_key),
  CONSTRAINT creation_reference_materials_session_fk FOREIGN KEY (session_id) REFERENCES public.creation_sessions (id) ON DELETE CASCADE
);

-- 会话列表（活跃部分）使用与真实 predicate 一致的 partial 复合索引：等值列在前、范围列在后；
-- 已删除行由 deleted_at IS NULL 谓词排除。keyset 分页 (created_at, id) 双排序键全覆盖。
CREATE INDEX creation_sessions_active_listing_idx
  ON public.creation_sessions (owner_user_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- 每个 Foreign Key 都有匹配索引（规格要求）：owner FK 需要覆盖全部行（含逻辑删除行），
-- 因此单独建完整索引；materials 按所属会话的牌堆读取走 (session_id, created_at, id ASC)
-- 覆盖查询序，同时充当 session_id FK 索引。
CREATE INDEX creation_sessions_owner_fk_idx
  ON public.creation_sessions (owner_user_id);

CREATE INDEX creation_reference_materials_session_listing_idx
  ON public.creation_reference_materials (session_id, created_at ASC, id ASC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.creation_sessions TO identity_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.creation_reference_materials TO identity_app;
