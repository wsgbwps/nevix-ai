-- Creator-private failed result slots retain one bounded diagnostic explaining
-- the stable failure_reason. Nullable columns keep existing rows valid and let
-- legacy/admission failures continue without inventing provider detail.
--
-- No index is added: diagnostics are read only with their slot through the
-- existing (task_id, slot_index) primary-key access path.
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

ALTER TABLE public.creation_generation_slots
  ADD COLUMN failure_diagnostic_source text,
  ADD COLUMN failure_diagnostic_code text,
  ADD COLUMN failure_diagnostic_message text,
  ADD COLUMN failure_diagnostic_http_status integer,
  ADD COLUMN failure_diagnostic_provider_type text,
  ADD COLUMN failure_diagnostic_request_id text,
  ADD CONSTRAINT creation_generation_slots_failure_diagnostic_check CHECK (
    (
      failure_diagnostic_source IS NULL
      AND failure_diagnostic_code IS NULL
      AND failure_diagnostic_message IS NULL
      AND failure_diagnostic_http_status IS NULL
      AND failure_diagnostic_provider_type IS NULL
      AND failure_diagnostic_request_id IS NULL
    )
    OR
    (
      status IS NOT NULL
      AND failure_diagnostic_source IS NOT NULL
      AND failure_diagnostic_code IS NOT NULL
      AND failure_diagnostic_message IS NOT NULL
      AND status = ANY (ARRAY['failed'::text, 'timed_out'::text, 'indeterminate'::text])
      AND failure_diagnostic_source = ANY (ARRAY[
        'provider'::text, 'output_transfer'::text, 'storage'::text, 'media_probe'::text
      ])
      AND char_length(failure_diagnostic_code) BETWEEN 1 AND 128
      AND char_length(failure_diagnostic_message) BETWEEN 1 AND 2000
      AND (
        failure_diagnostic_http_status IS NULL
        OR failure_diagnostic_http_status BETWEEN 100 AND 599
      )
      AND (
        failure_diagnostic_provider_type IS NULL
        OR char_length(failure_diagnostic_provider_type) BETWEEN 1 AND 128
      )
      AND (
        failure_diagnostic_request_id IS NULL
        OR char_length(failure_diagnostic_request_id) BETWEEN 1 AND 256
      )
    )
  );
