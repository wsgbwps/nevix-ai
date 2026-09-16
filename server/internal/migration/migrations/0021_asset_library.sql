-- Asset Library visibility is independent of the private source task/session.
-- Deletion is logical because task results and Assets share the verified blob.
-- restricted_at is issue #165's read-side projection; non-null Assets stay hidden.

-- +goose Up

ALTER TABLE public.creation_media_assets
  ADD COLUMN deleted_at timestamp with time zone,
  ADD COLUMN restricted_at timestamp with time zone;

CREATE INDEX creation_media_assets_visible_created_idx
  ON public.creation_media_assets (created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND restricted_at IS NULL;

CREATE INDEX creation_media_assets_visible_media_created_idx
  ON public.creation_media_assets (media_type, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND restricted_at IS NULL;

CREATE INDEX creation_media_assets_visible_owner_created_idx
  ON public.creation_media_assets (owner_user_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND restricted_at IS NULL;

CREATE INDEX creation_media_assets_visible_owner_media_created_idx
  ON public.creation_media_assets (owner_user_id, media_type, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND restricted_at IS NULL;

GRANT UPDATE (deleted_at) ON public.creation_media_assets TO identity_app;
