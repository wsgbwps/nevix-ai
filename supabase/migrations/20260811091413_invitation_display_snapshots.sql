-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

ALTER TABLE public.invitations
  ADD COLUMN organization_name text;

ALTER TABLE public.invitations
  ADD COLUMN inviter_display_name text;