-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

ALTER TABLE public.object_storage_connections
  ADD COLUMN location_frozen_at timestamp with time zone;

ALTER TABLE public.object_storage_connections
  DROP CONSTRAINT object_storage_connections_check_outcome_check,
  ADD CONSTRAINT object_storage_connections_check_outcome_check CHECK (
    last_check_outcome IN ('completed', 'temporarily_unavailable')
  );

-- The first permanent object freezes location forever, even when that
-- object's later business lifecycle removes its row.
-- +goose StatementBegin
CREATE FUNCTION public.creation_freeze_object_storage_location()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.object_storage_connections
  SET location_frozen_at = COALESCE(location_frozen_at, now()),
      updated_at = CASE WHEN location_frozen_at IS NULL THEN now() ELSE updated_at END
  WHERE terminated_at IS NULL;
  RETURN NEW;
END;
$$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION public.creation_freeze_object_storage_location() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creation_freeze_object_storage_location() TO identity_app;

CREATE TRIGGER creation_reference_material_freezes_object_storage_location
AFTER INSERT ON public.creation_reference_materials
FOR EACH STATEMENT EXECUTE FUNCTION public.creation_freeze_object_storage_location();

CREATE TRIGGER creation_media_asset_freezes_object_storage_location
AFTER INSERT ON public.creation_media_assets
FOR EACH STATEMENT EXECUTE FUNCTION public.creation_freeze_object_storage_location();

ALTER TABLE public.reauth_proofs
  DROP CONSTRAINT reauth_proofs_action_allowed,
  ADD CONSTRAINT reauth_proofs_action_allowed CHECK (
    action IN (
      'provider_connection.create',
      'provider_connection.replace',
      'provider_connection.delete',
      'object_storage_connection.create',
      'object_storage_connection.replace',
      'object_storage_connection.rotate',
      'object_storage_connection.delete',
      'object_storage_connection.recover'
    )
  );
