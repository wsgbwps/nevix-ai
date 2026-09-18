-- Up-only (ADR-0013): no Down section is ever provided.
--
-- COS credentials bind their provider into the AEAD AAD. Preserve historical
-- rows byte-for-byte except for this explicit compatibility state: the new
-- runtime must neither reinterpret their ciphertext as OSS nor perform COS I/O.

-- +goose Up

ALTER TABLE public.object_storage_connections
  DROP CONSTRAINT object_storage_connections_state_check,
  ADD CONSTRAINT object_storage_connections_state_check CHECK (
    state IN ('ready', 'credential_unavailable', 'legacy_incompatible')
  );

UPDATE public.object_storage_connections
SET state = 'legacy_incompatible', updated_at = now()
WHERE provider = 'cos';

ALTER TABLE public.object_storage_connections
  DROP CONSTRAINT object_storage_connections_provider_check,
  ADD CONSTRAINT object_storage_connections_provider_check CHECK (
    provider = 'oss' OR (provider = 'cos' AND state = 'legacy_incompatible')
  ),
  DROP CONSTRAINT object_storage_connections_state_check,
  ADD CONSTRAINT object_storage_connections_state_check CHECK (
    state IN ('ready', 'credential_unavailable')
    OR (state = 'legacy_incompatible' AND provider = 'cos')
  );
