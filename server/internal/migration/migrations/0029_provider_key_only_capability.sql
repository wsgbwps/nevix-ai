-- The provider check now validates the Key, not model visibility. An existing
-- valid Key needs no network recheck before the code-versioned models become
-- available. Preserve invalid/checking states and terminated history.
-- Up-only (ADR-0013, ADR-0025).

-- +goose Up

UPDATE public.provider_connections
SET image_capability = 'available',
    video_capability = 'available',
    updated_at = now()
WHERE terminated_at IS NULL
  AND credential_state = 'valid'
  AND (image_capability <> 'available' OR video_capability <> 'available');
