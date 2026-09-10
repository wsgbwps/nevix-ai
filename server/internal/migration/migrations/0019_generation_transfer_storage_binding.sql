-- A generation task binds to the singleton Object Storage Connection immediately
-- before its first provider-output write. Location replacement and termination use
-- this durable fact to fence only transfers that have started, while ordinary queued
-- work remains free to use a newly verified location.
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

ALTER TABLE public.creation_generation_tasks
  ADD COLUMN object_storage_connection_id uuid,
  ADD CONSTRAINT creation_generation_tasks_object_storage_connection_fk
    FOREIGN KEY (object_storage_connection_id) REFERENCES public.object_storage_connections (id);

CREATE INDEX creation_generation_tasks_active_storage_binding_idx
  ON public.creation_generation_tasks (object_storage_connection_id)
  WHERE object_storage_connection_id IS NOT NULL AND terminal_at IS NULL;
