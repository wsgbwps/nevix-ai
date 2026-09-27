-- A deleted session cannot regain material reuse, but a live task may still
-- prove that its old removed reference object exists.

-- +goose Up
ALTER TABLE public.creation_reference_materials
  ADD COLUMN legacy_object_verified_at timestamptz;
