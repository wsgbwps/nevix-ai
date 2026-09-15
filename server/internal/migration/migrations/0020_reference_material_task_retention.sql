-- Separate Composer removal from task retention (ADR-0016); up-only (ADR-0013).

-- +goose Up

ALTER TABLE public.creation_reference_materials
  ADD COLUMN removed_at timestamp with time zone;

CREATE TABLE public.creation_generation_task_references (
  task_id     uuid NOT NULL,
  material_id uuid NOT NULL,
  CONSTRAINT creation_generation_task_references_pkey PRIMARY KEY (task_id, material_id),
  CONSTRAINT creation_generation_task_references_task_fk
    FOREIGN KEY (task_id) REFERENCES public.creation_generation_tasks (id) ON DELETE CASCADE,
  CONSTRAINT creation_generation_task_references_material_fk
    FOREIGN KEY (material_id) REFERENCES public.creation_reference_materials (id)
);

CREATE INDEX creation_generation_task_references_material_fk_idx
  ON public.creation_generation_task_references (material_id);

-- Stored Go UUIDs are byte arrays; leave frozen specifications unchanged.
WITH task_references AS (
  SELECT task.id AS task_id,
    CASE jsonb_typeof(reference.value -> 'material_id')
      WHEN 'array' THEN (
        SELECT string_agg(lpad(to_hex(byte.value::integer), 2, '0'), '' ORDER BY byte.ordinality)
        FROM jsonb_array_elements_text(reference.value -> 'material_id')
          WITH ORDINALITY AS byte(value, ordinality)
      )::uuid
      ELSE (reference.value ->> 'material_id')::uuid
    END AS material_id
  FROM public.creation_generation_tasks AS task
  CROSS JOIN LATERAL jsonb_array_elements(task.specification -> 'references') AS reference(value)
)
INSERT INTO public.creation_generation_task_references (task_id, material_id)
SELECT DISTINCT reference.task_id, material.id
FROM task_references AS reference
JOIN public.creation_reference_materials AS material
  ON material.id = reference.material_id
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT ON public.creation_generation_task_references TO identity_app;

-- Serialize final release with Composer removal before checking remaining retainers.
-- +goose StatementBegin
CREATE FUNCTION public.creation_release_removed_material_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  material_removed_at timestamp with time zone;
BEGIN
  SELECT removed_at INTO material_removed_at
  FROM public.creation_reference_materials
  WHERE id = OLD.material_id
  FOR UPDATE;

  IF material_removed_at IS NULL OR EXISTS (
    SELECT 1 FROM public.creation_generation_task_references
    WHERE material_id = OLD.material_id
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE public.creation_reference_material_uploads
  SET cleanup_attempt_count = GREATEST(cleanup_attempt_count, 1),
      cleanup_next_attempt_at = clock_timestamp()
  WHERE material_id = OLD.material_id AND status = 'finalized'
    AND cleanup_confirmed_at IS NULL;
  RETURN NULL;
END;
$$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION public.creation_release_removed_material_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creation_release_removed_material_retention() TO identity_app;

CREATE TRIGGER creation_task_reference_releases_removed_material
AFTER DELETE ON public.creation_generation_task_references
FOR EACH ROW EXECUTE FUNCTION public.creation_release_removed_material_retention();
