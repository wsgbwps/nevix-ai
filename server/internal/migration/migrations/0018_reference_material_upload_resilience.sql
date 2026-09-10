-- Reference Material Upload 在失败、并发与进程重启后仍以 PostgreSQL 事实收敛。
-- verification token 为接管后的写入 fencing；terminal 行自身同时承载精确对象清理重试事实。
-- Tombstone 不在 V1 清理，因而天然满足至少七天的保留要求。
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

ALTER TABLE public.creation_reference_material_uploads
  DROP CONSTRAINT creation_reference_material_uploads_status_check,
  DROP CONSTRAINT creation_reference_material_uploads_finalized_at_check;

ALTER TABLE public.creation_reference_material_uploads
  ADD COLUMN verification_token uuid,
  ADD COLUMN verification_lease_until timestamp with time zone,
  ADD COLUMN terminal_at timestamp with time zone,
  ADD COLUMN cleanup_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN cleanup_next_attempt_at timestamp with time zone,
  ADD COLUMN cleanup_confirmed_at timestamp with time zone,
  ADD CONSTRAINT creation_reference_material_uploads_status_check
    CHECK (status IN ('pending', 'verifying', 'finalized', 'terminal')),
  ADD CONSTRAINT creation_reference_material_uploads_cleanup_attempt_check
    CHECK (cleanup_attempt_count >= 0),
  ADD CONSTRAINT creation_reference_material_uploads_state_facts_check CHECK (
    (status = 'pending'
      AND verification_token IS NULL AND verification_lease_until IS NULL
      AND finalized_at IS NULL AND terminal_at IS NULL
      AND cleanup_attempt_count = 0 AND cleanup_next_attempt_at IS NULL
      AND cleanup_confirmed_at IS NULL)
    OR (status = 'verifying'
      AND verification_token IS NOT NULL AND verification_lease_until IS NOT NULL
      AND finalized_at IS NULL AND terminal_at IS NULL
      AND cleanup_attempt_count = 0 AND cleanup_next_attempt_at IS NULL
      AND cleanup_confirmed_at IS NULL)
    OR (status = 'finalized'
      AND verification_token IS NULL AND verification_lease_until IS NULL
      AND finalized_at IS NOT NULL AND terminal_at IS NULL
      AND ((cleanup_attempt_count = 0 AND cleanup_next_attempt_at IS NULL
          AND cleanup_confirmed_at IS NULL)
        OR (cleanup_attempt_count > 0
          AND ((cleanup_confirmed_at IS NULL AND cleanup_next_attempt_at IS NOT NULL)
            OR (cleanup_confirmed_at IS NOT NULL AND cleanup_next_attempt_at IS NULL)))))
    OR (status = 'terminal'
      AND verification_token IS NULL AND verification_lease_until IS NULL
      AND finalized_at IS NULL AND terminal_at IS NOT NULL
      AND ((cleanup_confirmed_at IS NULL AND cleanup_next_attempt_at IS NOT NULL)
        OR (cleanup_confirmed_at IS NOT NULL AND cleanup_next_attempt_at IS NULL)))
  );

CREATE INDEX creation_reference_material_uploads_cleanup_due_idx
  ON public.creation_reference_material_uploads (cleanup_next_attempt_at, id)
  WHERE status IN ('terminal', 'finalized') AND cleanup_confirmed_at IS NULL;

CREATE INDEX creation_reference_material_uploads_active_deadline_idx
  ON public.creation_reference_material_uploads (finalize_deadline, id)
  WHERE status IN ('pending', 'verifying');
