-- Creation Session 可恢复草稿（AI Creation V1 Workbench 切片，issue #177）。
-- 草稿是 Session 聚合内的生成意图：标量意图值以结构化列存放在 creation_sessions 上，
-- 有序 Reference Material identity/role 以子表表达（排序是结构化事实，不是 JSONB）。
-- 值域约束刻意宽松于当前 Capability Manifest：manifest 移除的历史值必须能原样保留
-- （不静默替换或降级），合法性由提交时按 manifest 权威校验（spec #150）。
-- 素材删除经 FK ON DELETE CASCADE 同步移除草稿条目：既有素材生命周期规则不漂移。
--
-- 授权基线不变（ADR-0016）：草稿随 creation_sessions 的 owner_user_id 行级谓词保持
-- creator-private，写路径继续使用 identity_app 与 Creation 写事务；不新增数据库角色。
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

ALTER TABLE public.creation_sessions
  ADD COLUMN draft_prompt            text NOT NULL DEFAULT '',
  ADD COLUMN draft_media_type        text,
  ADD COLUMN draft_manifest_version  integer,
  ADD COLUMN draft_model             text,
  ADD COLUMN draft_mode              text,
  ADD COLUMN draft_ratio             text,
  ADD COLUMN draft_resolution        text,
  ADD COLUMN draft_quantity          integer,
  ADD COLUMN draft_duration_seconds  integer,
  ADD COLUMN draft_updated_at        timestamp with time zone,
  ADD CONSTRAINT creation_sessions_draft_prompt_len_check
    CHECK (char_length(draft_prompt) <= 2000),
  ADD CONSTRAINT creation_sessions_draft_media_type_check
    CHECK (draft_media_type IS NULL OR draft_media_type = ANY (ARRAY['image'::text, 'video'::text])),
  ADD CONSTRAINT creation_sessions_draft_manifest_version_check
    CHECK (draft_manifest_version IS NULL OR draft_manifest_version >= 1),
  ADD CONSTRAINT creation_sessions_draft_model_len_check
    CHECK (draft_model IS NULL OR char_length(draft_model) <= 128),
  ADD CONSTRAINT creation_sessions_draft_mode_len_check
    CHECK (draft_mode IS NULL OR char_length(draft_mode) <= 64),
  ADD CONSTRAINT creation_sessions_draft_ratio_len_check
    CHECK (draft_ratio IS NULL OR char_length(draft_ratio) <= 16),
  ADD CONSTRAINT creation_sessions_draft_resolution_len_check
    CHECK (draft_resolution IS NULL OR char_length(draft_resolution) <= 16),
  ADD CONSTRAINT creation_sessions_draft_quantity_check
    CHECK (draft_quantity IS NULL OR draft_quantity BETWEEN 1 AND 4),
  ADD CONSTRAINT creation_sessions_draft_duration_check
    CHECK (draft_duration_seconds IS NULL OR draft_duration_seconds > 0);

CREATE TABLE public.creation_session_draft_references (
  session_id  uuid    NOT NULL,
  position    integer NOT NULL,
  material_id uuid    NOT NULL,
  role        text    NOT NULL,
  -- (session_id, position) 是牌堆顺序的持久主键：保存即整体替换，顺序由事务保证连续。
  CONSTRAINT creation_session_draft_references_pkey PRIMARY KEY (session_id, position),
  CONSTRAINT creation_session_draft_references_position_check CHECK (position >= 0),
  CONSTRAINT creation_session_draft_references_role_check
    CHECK (role = ANY (ARRAY['reference'::text, 'first_frame'::text, 'last_frame'::text, 'omni'::text])),
  CONSTRAINT creation_session_draft_references_session_fk
    FOREIGN KEY (session_id) REFERENCES public.creation_sessions (id) ON DELETE CASCADE,
  -- 素材被删除时草稿条目随之消失；会话删除时级联清空草稿引用。
  CONSTRAINT creation_session_draft_references_material_fk
    FOREIGN KEY (material_id) REFERENCES public.creation_reference_materials (id) ON DELETE CASCADE
);

-- 每个 Foreign Key 都有匹配索引（规格要求）。
CREATE INDEX creation_session_draft_references_material_fk_idx
  ON public.creation_session_draft_references (material_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.creation_session_draft_references TO identity_app;
