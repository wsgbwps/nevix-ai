-- Admin safety restrictions retain history without restoring a terminated Publication.
-- Publication direct state stays separate from an Asset cascade so releasing one cause
-- cannot silently release the other.

-- +goose Up

ALTER TABLE public.creation_media_assets
  ADD COLUMN restriction_released_at timestamp with time zone,
  ADD CONSTRAINT creation_media_assets_restriction_lifecycle_check CHECK (
    restriction_released_at IS NULL OR
    (restricted_at IS NOT NULL AND restriction_released_at >= restricted_at)
  );

ALTER TABLE public.creation_team_publications
  ADD COLUMN direct_restricted_at timestamp with time zone,
  ADD COLUMN direct_restriction_released_at timestamp with time zone,
  ADD CONSTRAINT creation_team_publications_direct_restriction_check CHECK (
    direct_restricted_at IS NULL OR restricted_at IS NOT NULL
  ),
  ADD CONSTRAINT creation_team_publications_direct_release_check CHECK (
    direct_restriction_released_at IS NULL OR
    (direct_restricted_at IS NOT NULL AND direct_restriction_released_at >= direct_restricted_at)
  );

UPDATE public.creation_team_publications
SET direct_restricted_at = restricted_at
WHERE restricted_at IS NOT NULL;

DROP INDEX public.creation_media_assets_visible_created_idx;
DROP INDEX public.creation_media_assets_visible_media_created_idx;
DROP INDEX public.creation_media_assets_visible_owner_created_idx;
DROP INDEX public.creation_media_assets_visible_owner_media_created_idx;

CREATE INDEX creation_media_assets_visible_created_idx
  ON public.creation_media_assets (created_at DESC, id DESC)
  WHERE deleted_at IS NULL
    AND (restricted_at IS NULL OR restriction_released_at IS NOT NULL);

CREATE INDEX creation_media_assets_visible_media_created_idx
  ON public.creation_media_assets (media_type, created_at DESC, id DESC)
  WHERE deleted_at IS NULL
    AND (restricted_at IS NULL OR restriction_released_at IS NOT NULL);

CREATE INDEX creation_media_assets_visible_owner_created_idx
  ON public.creation_media_assets (owner_user_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL
    AND (restricted_at IS NULL OR restriction_released_at IS NOT NULL);

CREATE INDEX creation_media_assets_visible_owner_media_created_idx
  ON public.creation_media_assets (owner_user_id, media_type, created_at DESC, id DESC)
  WHERE deleted_at IS NULL
    AND (restricted_at IS NULL OR restriction_released_at IS NOT NULL);

GRANT UPDATE (restricted_at, restriction_released_at)
  ON public.creation_media_assets TO identity_app;
GRANT UPDATE (direct_restricted_at, direct_restriction_released_at)
  ON public.creation_team_publications TO identity_app;
