-- Team Publication freezes one successful Asset and its actual ordered inputs.
-- Create Similar aliases immutable objects; no result or reference bytes are copied.

-- +goose Up

ALTER TABLE public.creation_reference_materials
  DROP CONSTRAINT creation_reference_materials_blob_key_key;

CREATE INDEX creation_reference_materials_blob_key_idx
  ON public.creation_reference_materials (blob_key);

CREATE TABLE public.creation_team_publications (
  id                     uuid                     NOT NULL DEFAULT gen_random_uuid(),
  source_asset_id        uuid                     NOT NULL,
  publisher_user_id      uuid                     NOT NULL,
  publisher_display_name text                     NOT NULL,
  idempotency_key        text                     NOT NULL,
  media_type             text                     NOT NULL,
  mime                   text                     NOT NULL,
  blob_key               text                     NOT NULL,
  byte_size              bigint                   NOT NULL,
  checksum               bytea                    NOT NULL,
  width_px               integer,
  height_px              integer,
  duration_ms            integer,
  specification          jsonb                    NOT NULL,
  published_at           timestamp with time zone NOT NULL DEFAULT now(),
  withdrawn_at           timestamp with time zone,
  restricted_at          timestamp with time zone,
  CONSTRAINT creation_team_publications_pkey PRIMARY KEY (id),
  CONSTRAINT creation_team_publications_asset_fk FOREIGN KEY (source_asset_id) REFERENCES public.creation_media_assets (id),
  CONSTRAINT creation_team_publications_publisher_fk FOREIGN KEY (publisher_user_id) REFERENCES public.users (id),
  CONSTRAINT creation_team_publications_publisher_key_unique UNIQUE (publisher_user_id, idempotency_key),
  CONSTRAINT creation_team_publications_key_check CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  CONSTRAINT creation_team_publications_media_check CHECK (media_type IN ('image', 'video')),
  CONSTRAINT creation_team_publications_size_check CHECK (byte_size > 0 AND byte_size <= 1073741824)
);

CREATE UNIQUE INDEX creation_team_publications_active_asset_idx
  ON public.creation_team_publications (source_asset_id)
  WHERE withdrawn_at IS NULL AND restricted_at IS NULL;

CREATE INDEX creation_team_publications_active_created_idx
  ON public.creation_team_publications (published_at DESC, id DESC)
  WHERE withdrawn_at IS NULL AND restricted_at IS NULL;

CREATE INDEX creation_team_publications_active_media_created_idx
  ON public.creation_team_publications (media_type, published_at DESC, id DESC)
  WHERE withdrawn_at IS NULL AND restricted_at IS NULL;

CREATE INDEX creation_team_publications_publisher_fk_idx
  ON public.creation_team_publications (publisher_user_id);

CREATE INDEX creation_team_publications_asset_fk_idx
  ON public.creation_team_publications (source_asset_id);

CREATE INDEX creation_media_assets_admin_created_idx
  ON public.creation_media_assets (created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX creation_media_assets_admin_media_created_idx
  ON public.creation_media_assets (media_type, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE public.creation_team_publication_references (
  id              uuid    NOT NULL DEFAULT gen_random_uuid(),
  publication_id  uuid    NOT NULL,
  position        integer NOT NULL,
  role            text    NOT NULL,
  kind            text    NOT NULL,
  file_name       text    NOT NULL,
  mime_type       text    NOT NULL,
  byte_size       bigint  NOT NULL,
  checksum_sha256 bytea   NOT NULL,
  blob_key        text    NOT NULL,
  width_px        integer,
  height_px       integer,
  pixel_count     bigint,
  duration_ms     integer,
  claims_version  integer NOT NULL,
  CONSTRAINT creation_team_publication_references_pkey PRIMARY KEY (id),
  CONSTRAINT creation_team_publication_references_order_unique UNIQUE (publication_id, position),
  CONSTRAINT creation_team_publication_references_publication_fk FOREIGN KEY (publication_id) REFERENCES public.creation_team_publications (id) ON DELETE CASCADE,
  CONSTRAINT creation_team_publication_references_position_check CHECK (position >= 0 AND position < 14),
  CONSTRAINT creation_team_publication_references_role_check CHECK (role IN ('reference', 'first_frame', 'last_frame', 'omni')),
  CONSTRAINT creation_team_publication_references_kind_check CHECK (kind IN ('image', 'video', 'audio')),
  CONSTRAINT creation_team_publication_references_size_check CHECK (byte_size > 0 AND byte_size <= 209715200),
  CONSTRAINT creation_team_publication_references_claims_check CHECK (claims_version >= 1)
);

CREATE INDEX creation_team_publication_references_blob_key_idx
  ON public.creation_team_publication_references (blob_key);

CREATE TABLE public.creation_publication_similar_operations (
  id                uuid                     NOT NULL DEFAULT gen_random_uuid(),
  owner_user_id     uuid                     NOT NULL,
  publication_id    uuid                     NOT NULL,
  idempotency_key   text                     NOT NULL,
  session_id        uuid                     NOT NULL,
  specification     jsonb                    NOT NULL,
  created_at        timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT creation_publication_similar_operations_pkey PRIMARY KEY (id),
  CONSTRAINT creation_publication_similar_operations_owner_key_unique UNIQUE (owner_user_id, idempotency_key),
  CONSTRAINT creation_publication_similar_operations_owner_fk FOREIGN KEY (owner_user_id) REFERENCES public.users (id),
  CONSTRAINT creation_publication_similar_operations_publication_fk FOREIGN KEY (publication_id) REFERENCES public.creation_team_publications (id),
  CONSTRAINT creation_publication_similar_operations_session_fk FOREIGN KEY (session_id) REFERENCES public.creation_sessions (id),
  CONSTRAINT creation_publication_similar_operations_key_check CHECK (char_length(idempotency_key) BETWEEN 1 AND 128)
);

CREATE INDEX creation_publication_similar_operations_publication_fk_idx
  ON public.creation_publication_similar_operations (publication_id);
CREATE UNIQUE INDEX creation_publication_similar_operations_session_fk_idx
  ON public.creation_publication_similar_operations (session_id);

GRANT SELECT, INSERT ON public.creation_team_publications TO identity_app;
GRANT UPDATE (withdrawn_at, restricted_at) ON public.creation_team_publications TO identity_app;
GRANT SELECT, INSERT ON public.creation_team_publication_references TO identity_app;
GRANT SELECT, INSERT ON public.creation_publication_similar_operations TO identity_app;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.creation_release_removed_material_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  material_object_key text;
BEGIN
  SELECT blob_key INTO material_object_key
  FROM public.creation_reference_materials
  WHERE id = OLD.material_id
  FOR UPDATE;

  IF material_object_key IS NULL OR EXISTS (
    SELECT 1 FROM public.creation_reference_materials
    WHERE blob_key = material_object_key AND removed_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM public.creation_generation_task_references retained
    JOIN public.creation_reference_materials material ON material.id = retained.material_id
    WHERE material.blob_key = material_object_key
  ) OR EXISTS (
    SELECT 1 FROM public.creation_team_publication_references reference
    JOIN public.creation_team_publications publication ON publication.id = reference.publication_id
    WHERE reference.blob_key = material_object_key
      AND publication.withdrawn_at IS NULL AND publication.restricted_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE public.creation_reference_material_uploads
  SET cleanup_attempt_count = GREATEST(cleanup_attempt_count, 1),
      cleanup_next_attempt_at = clock_timestamp(),
      cleanup_confirmed_at = NULL
  WHERE creation_reference_material_uploads.object_key = material_object_key
    AND status = 'finalized';
  RETURN NULL;
END;
$$;
-- +goose StatementEnd

-- Publication restriction and withdrawal are terminal transitions. Schedule
-- exact-key cleanup in the same transaction after the final retainer leaves.
-- +goose StatementBegin
CREATE FUNCTION public.creation_release_publication_material_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.withdrawn_at IS NOT NULL OR OLD.restricted_at IS NOT NULL
    OR (NEW.withdrawn_at IS NULL AND NEW.restricted_at IS NULL) THEN
    RETURN NULL;
  END IF;

  UPDATE public.creation_reference_material_uploads AS upload
  SET cleanup_attempt_count = GREATEST(upload.cleanup_attempt_count, 1),
      cleanup_next_attempt_at = clock_timestamp(),
      cleanup_confirmed_at = NULL
  WHERE upload.status = 'finalized'
    AND upload.object_key IN (
      SELECT reference.blob_key
      FROM public.creation_team_publication_references AS reference
      WHERE reference.publication_id = OLD.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.creation_reference_materials AS material
      WHERE material.blob_key = upload.object_key AND material.removed_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.creation_generation_task_references AS retained
      JOIN public.creation_reference_materials AS material ON material.id = retained.material_id
      WHERE material.blob_key = upload.object_key
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.creation_team_publication_references AS reference
      JOIN public.creation_team_publications AS publication ON publication.id = reference.publication_id
      WHERE reference.blob_key = upload.object_key
        AND publication.withdrawn_at IS NULL AND publication.restricted_at IS NULL
    );
  RETURN NULL;
END;
$$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION public.creation_release_publication_material_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creation_release_publication_material_retention() TO identity_app;

CREATE TRIGGER creation_publication_releases_material_retention
AFTER UPDATE OF withdrawn_at, restricted_at ON public.creation_team_publications
FOR EACH ROW EXECUTE FUNCTION public.creation_release_publication_material_retention();
