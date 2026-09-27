-- Schedule exact-key cleanup when the final effective material holder leaves.
-- Up-only (ADR-0013).

-- +goose Up

-- +goose StatementBegin
CREATE FUNCTION public.creation_schedule_unretained_material_cleanup(material_object_key text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.creation_reference_material_uploads AS upload
  SET cleanup_attempt_count = GREATEST(upload.cleanup_attempt_count, 1),
      cleanup_next_attempt_at = clock_timestamp(),
      cleanup_confirmed_at = NULL
  WHERE upload.object_key = material_object_key AND upload.status = 'finalized'
    AND NOT EXISTS (
      SELECT 1 FROM public.creation_reference_materials AS material
      JOIN public.creation_sessions AS session ON session.id = material.session_id
      WHERE material.blob_key = material_object_key AND material.removed_at IS NULL
        AND session.deleted_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.creation_generation_task_references AS retained
      JOIN public.creation_reference_materials AS material ON material.id = retained.material_id
      JOIN public.creation_generation_tasks AS task ON task.id = retained.task_id
      WHERE material.blob_key = material_object_key AND task.dismissed_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.creation_team_publication_references AS reference
      JOIN public.creation_team_publications AS publication ON publication.id = reference.publication_id
      WHERE reference.blob_key = material_object_key
        AND publication.withdrawn_at IS NULL AND publication.restricted_at IS NULL
    );
END;
$$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION public.creation_schedule_unretained_material_cleanup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creation_schedule_unretained_material_cleanup(text) TO identity_app;

-- Lock material rows in key order after relation deletion, matching admission's
-- material lock so a new task cannot appear between the holder check and fact.
DROP TRIGGER creation_task_reference_releases_removed_material
  ON public.creation_generation_task_references;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.creation_release_removed_material_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  material_object_key text;
BEGIN
  FOR material_object_key IN
    SELECT material.blob_key
    FROM old_references AS released
    JOIN public.creation_reference_materials AS material ON material.id = released.material_id
    ORDER BY material.blob_key, material.id
    FOR UPDATE OF material
  LOOP
    PERFORM public.creation_schedule_unretained_material_cleanup(material_object_key);
  END LOOP;
  RETURN NULL;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER creation_task_reference_releases_removed_material
AFTER DELETE ON public.creation_generation_task_references
REFERENCING OLD TABLE AS old_references
FOR EACH STATEMENT EXECUTE FUNCTION public.creation_release_removed_material_retention();

-- +goose StatementBegin
CREATE FUNCTION public.creation_release_session_material_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  material_object_key text;
BEGIN
  IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN
    RETURN NULL;
  END IF;

  FOR material_object_key IN
    SELECT DISTINCT material.blob_key
    FROM public.creation_reference_materials AS material
    WHERE material.session_id = NEW.id
    ORDER BY material.blob_key
  LOOP
    PERFORM public.creation_schedule_unretained_material_cleanup(material_object_key);
  END LOOP;
  RETURN NULL;
END;
$$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION public.creation_release_session_material_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creation_release_session_material_retention() TO identity_app;

CREATE TRIGGER creation_session_releases_material_retention
AFTER UPDATE OF deleted_at ON public.creation_sessions
FOR EACH ROW EXECUTE FUNCTION public.creation_release_session_material_retention();

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.creation_release_publication_material_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  material_object_key text;
BEGIN
  IF OLD.withdrawn_at IS NOT NULL OR OLD.restricted_at IS NOT NULL
    OR (NEW.withdrawn_at IS NULL AND NEW.restricted_at IS NULL) THEN
    RETURN NULL;
  END IF;

  FOR material_object_key IN
    SELECT DISTINCT reference.blob_key
    FROM public.creation_team_publication_references AS reference
    WHERE reference.publication_id = OLD.id
    ORDER BY reference.blob_key
  LOOP
    PERFORM public.creation_schedule_unretained_material_cleanup(material_object_key);
  END LOOP;
  RETURN NULL;
END;
$$;
-- +goose StatementEnd

-- Result-derived materials predating this release have no upload row to carry
-- cleanup retries. Their upload-shaped rows are cleanup facts, not PUT leases;
-- declared size is capped only to satisfy the retired PUT shape constraint.
WITH missing AS (
  SELECT DISTINCT ON (material.blob_key)
    material.*, session.owner_user_id, gen_random_uuid() AS cleanup_id
  FROM public.creation_reference_materials AS material
  JOIN public.creation_sessions AS session ON session.id = material.session_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.creation_reference_material_uploads AS upload
    WHERE upload.object_key = material.blob_key OR upload.material_id = material.id
  )
  ORDER BY material.blob_key, material.created_at, material.id
)
INSERT INTO public.creation_reference_material_uploads (
  id, owner_user_id, session_id, material_id, object_key, file_name,
  declared_kind, declared_mime_type, declared_byte_size, claims_version,
  idempotency_key, payload_hash, connection_revision, put_deadline,
  finalize_deadline, status, created_at, finalized_at,
  cleanup_attempt_count, cleanup_next_attempt_at
)
SELECT material.cleanup_id, material.owner_user_id, material.session_id,
  material.id, material.blob_key,
  COALESCE(NULLIF(material.file_name, ''), 'material'), material.kind,
  COALESCE(NULLIF(left(material.mime_type, 255), ''), 'application/octet-stream'),
  LEAST(material.byte_size, CASE material.kind
    WHEN 'image' THEN 10485760 WHEN 'audio' THEN 52428800 ELSE 209715200 END),
  material.claims_version, material.cleanup_id::text,
  CASE WHEN octet_length(material.checksum_sha256) = 32 THEN material.checksum_sha256
    ELSE decode(repeat('00', 32), 'hex') END,
  1, material.created_at + interval '60 minutes',
  material.created_at + interval '90 minutes', 'finalized',
  material.created_at, material.created_at,
  0, NULL
FROM missing AS material
ON CONFLICT (object_key) DO NOTHING;

-- Existing finalized upload facts also need the new effective-holder rule:
-- a session may have been deleted before this trigger existed.
-- +goose StatementBegin
DO $$
DECLARE
  material_object_key text;
BEGIN
  FOR material_object_key IN
    SELECT DISTINCT object_key FROM public.creation_reference_material_uploads
    WHERE status = 'finalized' AND cleanup_confirmed_at IS NULL
      AND cleanup_next_attempt_at IS NULL
  LOOP
    PERFORM public.creation_schedule_unretained_material_cleanup(material_object_key);
  END LOOP;
END;
$$;
-- +goose StatementEnd
