-- Permit the trusted Creation repair transaction to release dismissed tasks' stale holds.

-- +goose Up
GRANT DELETE ON public.creation_generation_task_references TO identity_app;
