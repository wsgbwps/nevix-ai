-- Provider submit 的有界重试需要独立于通用 queue claim/poll 次数：一次 claim
-- 可能在外部调用前失败，而已接受的异步 Job 又需要远多于四次的安全 poll。
-- submit_attempts 只在提交 marker 事务内、紧邻外部调用前递增，作为 429/503
-- 四级退避预算的持久计数（issue #160）。
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

ALTER TABLE public.creation_provider_jobs
  ADD COLUMN submit_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE public.creation_provider_jobs
  ADD CONSTRAINT creation_provider_jobs_submit_attempts_check
  CHECK (submit_attempts >= 0);

-- 旧版本只记录最近一次明确的暂时拒绝，无法从通用 queue claim 次数还原真实
-- submit 次数。将这类可安全重试的历史行放到四次预算的最后一次；升级不会把
-- 结局未知的提交重新送出，也不会让历史 503 再经历一轮完整退避。
UPDATE public.creation_provider_jobs
SET submit_attempts = 3,
    updated_at = now()
WHERE status = 'submitting'
  AND external_ref IS NULL
  AND last_outcome = 'transient_rejected';

-- 旧 worker 可能已经把通用 claim 次数耗尽；这样的行即使 run_after 到期也不再
-- 可 claim。只恢复上面已证明外部未接受的提交；submit_attempts 约束最后一次
-- submit，而通用 queue 次数清零，为该 submit 若被接受后的异步 poll 保留完整预算。
UPDATE public.creation_generation_queue AS queue
SET attempts = 0,
    run_after = now(),
    lease_owner = NULL,
    lease_until = NULL,
    updated_at = now()
WHERE queue.attempts >= queue.max_attempts
  AND EXISTS (
    SELECT 1
    FROM public.creation_provider_jobs AS job
    JOIN public.creation_generation_tasks AS task ON task.id = job.task_id
    WHERE job.task_id = queue.task_id
      AND job.status = 'submitting'
      AND job.external_ref IS NULL
      AND job.last_outcome = 'transient_rejected'
      AND task.status = ANY (ARRAY[
        'queued'::text, 'submitting'::text, 'processing'::text,
        'persisting'::text, 'cancelling'::text
      ])
  );
