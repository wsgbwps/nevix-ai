-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

ALTER TABLE identity.verification_codes
  DROP CONSTRAINT verification_codes_status_check;

GRANT INSERT, SELECT, UPDATE ON identity.outbox_messages TO identity_app;

ALTER TABLE identity.verification_codes
  ADD CONSTRAINT verification_codes_status_check CHECK (status = ANY (ARRAY['active'::text, 'superseded'::text, 'consumed'::text]));

ALTER TABLE identity.verification_codes
  ADD COLUMN action_type text;

ALTER TABLE identity.verification_codes
  ADD COLUMN target_id uuid;

ALTER TABLE identity.verification_codes
  ADD COLUMN failed_attempts integer DEFAULT 0 NOT NULL;

GRANT INSERT, SELECT, UPDATE ON identity.verification_codes TO identity_app;

CREATE TABLE public.audit_logs (
  id                  uuid                     DEFAULT gen_random_uuid() NOT NULL,
  organization_id     uuid                     NOT NULL,
  actor_user_id       uuid                     NOT NULL,
  actor_display_name  text                     NOT NULL,
  target_user_id      uuid,
  target_display_name text,
  action              text                     NOT NULL,
  metadata            jsonb                    DEFAULT '{}'::jsonb NOT NULL,
  created_at          timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.audit_logs
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);

-- Keep API roles strictly SELECT-only. RLS does not constrain the platform's
-- default TRUNCATE/DDL-adjacent grants, so remove them explicitly before
-- granting the intended read surface.
REVOKE ALL ON public.audit_logs FROM anon, authenticated;

GRANT SELECT ON public.audit_logs TO authenticated;

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON public.audit_logs TO service_role;

GRANT DELETE, INSERT, SELECT ON public.audit_logs TO identity_app;

CREATE INDEX audit_logs_organization_id_created_at_idx ON public.audit_logs (organization_id, created_at DESC);

CREATE POLICY audit_logs_select_owner_or_admin ON public.audit_logs
  FOR SELECT
  TO authenticated
  USING (identity.has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text]));

CREATE POLICY identity_app_all ON public.audit_logs
  TO identity_app
  USING (true)
  WITH CHECK (true);

CREATE TABLE public.invitations (
  id              uuid                     DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid                     NOT NULL,
  email           text                     NOT NULL,
  status          text                     DEFAULT 'pending'::text NOT NULL,
  expires_at      timestamp with time zone NOT NULL,
  created_at      timestamp with time zone DEFAULT now() NOT NULL,
  updated_at      timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.invitations
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.invitations
  ADD CONSTRAINT invitations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.invitations
  ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);

ALTER TABLE public.invitations
  ADD CONSTRAINT invitations_status_check CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text]));

REVOKE ALL ON public.invitations FROM anon, authenticated;

GRANT SELECT ON public.invitations TO authenticated;

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON public.invitations TO service_role;

GRANT INSERT, SELECT, UPDATE ON public.invitations TO identity_app;

CREATE INDEX invitations_organization_id_idx ON public.invitations (organization_id);

CREATE INDEX invitations_pending_email_idx ON public.invitations (email)
  WHERE status = 'pending'::text;

CREATE UNIQUE INDEX invitations_pending_organization_email_idx ON public.invitations (organization_id, email)
  WHERE status = 'pending'::text;

CREATE POLICY identity_app_all ON public.invitations
  TO identity_app
  USING (true)
  WITH CHECK (true);

CREATE POLICY invitations_select_admin_or_invitee ON public.invitations
  FOR SELECT
  TO authenticated
  USING ((identity.has_org_role(organization_id, ARRAY['owner'::text, 'admin'::text]) OR ((status = 'pending'::text) AND (email = (( SELECT auth.jwt()) ->> 'email'::text)))));