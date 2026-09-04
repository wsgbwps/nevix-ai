-- 会话草稿退场为设备本地状态（ADR-0017）：submitTask 携带完整生成意图，
-- 服务端不再保存可编辑草稿，本迁移删除迁移 0007 建立的全部草稿存储面与
-- 任务行的 draft_revision 冻结来源列。未提交草稿按该决定本就无保留价值，
-- 与停写同一发布原子完成（on-prem 桌面与服务端同装同发，无外部消费者）。
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

DROP TABLE IF EXISTS public.creation_session_draft_references;

ALTER TABLE public.creation_sessions
  DROP COLUMN IF EXISTS draft_prompt,
  DROP COLUMN IF EXISTS draft_media_type,
  DROP COLUMN IF EXISTS draft_manifest_version,
  DROP COLUMN IF EXISTS draft_model,
  DROP COLUMN IF EXISTS draft_mode,
  DROP COLUMN IF EXISTS draft_ratio,
  DROP COLUMN IF EXISTS draft_resolution,
  DROP COLUMN IF EXISTS draft_quantity,
  DROP COLUMN IF EXISTS draft_duration_seconds,
  DROP COLUMN IF EXISTS draft_updated_at;

ALTER TABLE public.creation_generation_tasks
  DROP COLUMN IF EXISTS draft_revision;
