-- Kapon 的 MODEL_GROUP_ALL_UNAVAILABLE 经 adapter 精确白名单映射为稳定
-- provider_route_unavailable reason，使 creator 能区分模型渠道不可用与一般
-- 临时故障；原始 message、request ID 与响应体不持久化（ADR-0016）。
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

ALTER TABLE public.creation_generation_slots
  DROP CONSTRAINT creation_generation_slots_reason_check;

ALTER TABLE public.creation_generation_slots
  ADD CONSTRAINT creation_generation_slots_reason_check CHECK (
    failure_reason IS NULL OR failure_reason = ANY (ARRAY[
      'invalid_input'::text, 'rights_confirmation_required'::text,
      'input_policy_rejected'::text, 'output_policy_rejected'::text,
      'action_required'::text, 'temporarily_unavailable'::text,
      'provider_route_unavailable'::text, 'processing_indeterminate'::text,
      'internal_error'::text
    ])
  );
