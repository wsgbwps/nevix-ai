-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

SET check_function_bodies = false;

-- Single Go role for trusted commands, the Outbox Worker, and the retention
-- sweep (ADR-0008): LOGIN without BYPASSRLS, admitted through the permissive
-- policies below. No password is part of the migration; deployment
-- provisioning owns credentials. Idempotent because db reset replays
-- migrations against a cluster where the role outlives the dropped database.
-- (pg-delta does not diff roles, so this block is maintained by hand.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'identity_app') THEN
    CREATE ROLE identity_app LOGIN;
  END IF;
END
$$;

-- The local/ops superuser-equivalent `postgres` is not a true superuser, so
-- it needs membership to SET ROLE into identity_app (tests and maintenance).
GRANT identity_app TO postgres;

GRANT USAGE ON SCHEMA identity TO authenticated;

GRANT USAGE ON SCHEMA identity TO identity_app;

CREATE FUNCTION identity.has_org_role (
  p_organization_id uuid,
  p_roles           text[]
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE organization_id = p_organization_id
      AND user_id = (select auth.uid())
      AND status = 'active'
      AND role = ANY (p_roles)
  );
$function$;

GRANT EXECUTE ON FUNCTION identity.has_org_role(uuid, text[]) TO authenticated;

GRANT EXECUTE ON FUNCTION identity.has_org_role(uuid, text[]) TO identity_app;

CREATE FUNCTION identity.is_active_member (
  p_organization_id uuid
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE organization_id = p_organization_id
      AND user_id = (select auth.uid())
      AND status = 'active'
  );
$function$;

GRANT EXECUTE ON FUNCTION identity.is_active_member(uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION identity.is_active_member(uuid) TO identity_app;

CREATE FUNCTION identity.shares_active_org (
  p_user_id uuid
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships mine
    JOIN public.memberships theirs
      ON theirs.organization_id = mine.organization_id
     AND theirs.status = 'active'
    WHERE mine.user_id = (select auth.uid())
      AND mine.status = 'active'
      AND theirs.user_id = p_user_id
  );
$function$;

GRANT EXECUTE ON FUNCTION identity.shares_active_org(uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION identity.shares_active_org(uuid) TO identity_app;

-- Supabase default privileges hand EXECUTE on every postgres-created function
-- to PUBLIC-adjacent API roles; strip it so only the intentional grantees
-- above can call the helpers (PUBLIC/anon keep none, per ADR-0008).
REVOKE EXECUTE ON FUNCTION identity.has_org_role(uuid, text[]) FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION identity.is_active_member(uuid) FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION identity.shares_active_org(uuid) FROM PUBLIC, anon;

CREATE VIEW identity.directory AS SELECT id,
    email
   FROM auth.users;

GRANT SELECT ON identity.directory TO identity_app;

GRANT USAGE ON SCHEMA public TO identity_app;

CREATE TABLE public.memberships (
  id              uuid                     DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid                     NOT NULL,
  user_id         uuid                     NOT NULL,
  role            text                     NOT NULL,
  status          text                     NOT NULL,
  created_at      timestamp with time zone DEFAULT now() NOT NULL,
  updated_at      timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.memberships
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.memberships
  ADD CONSTRAINT memberships_pkey PRIMARY KEY (id);

ALTER TABLE public.memberships
  ADD CONSTRAINT memberships_role_check CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]));

ALTER TABLE public.memberships
  ADD CONSTRAINT memberships_status_check CHECK (status = ANY (ARRAY['active'::text, 'ended'::text]));

ALTER TABLE public.memberships
  ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- Platform default privileges auto-grant anon/authenticated MAINTAIN,
-- REFERENCES, TRIGGER, and TRUNCATE on every table postgres creates; strip
-- them so the client ACL is exactly the intentional grants below (RLS does
-- not protect TRUNCATE). service_role keeps its platform defaults: it is the
-- stack's server-side trusted role, not a client role.
REVOKE ALL ON public.memberships FROM anon, authenticated;

GRANT SELECT ON public.memberships TO authenticated;

GRANT INSERT, SELECT, UPDATE ON public.memberships TO identity_app;

CREATE INDEX memberships_user_id_idx ON public.memberships (user_id);

CREATE INDEX memberships_organization_id_idx ON public.memberships (organization_id);

CREATE UNIQUE INDEX memberships_active_owner_idx ON public.memberships (organization_id)
  WHERE ROLE = 'owner'::text AND status = 'active'::text;

CREATE UNIQUE INDEX memberships_active_member_idx ON public.memberships (organization_id, user_id)
  WHERE status = 'active'::text;

CREATE POLICY identity_app_all ON public.memberships
  TO identity_app
  USING (true)
  WITH CHECK (true);

CREATE POLICY memberships_select_own_or_active_org ON public.memberships
  FOR SELECT
  TO authenticated
  USING (((user_id = ( SELECT auth.uid() AS uid)) OR ((status = 'active'::text) AND identity.is_active_member(organization_id))));

CREATE TABLE public.organizations (
  id         uuid                     NOT NULL,
  name       text                     NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.organizations
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_name_check CHECK (char_length(TRIM(BOTH FROM name)) >= 1);

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);

ALTER TABLE public.memberships
  ADD CONSTRAINT memberships_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

REVOKE ALL ON public.organizations FROM anon, authenticated;

GRANT SELECT ON public.organizations TO authenticated;

GRANT INSERT, SELECT, UPDATE ON public.organizations TO identity_app;

CREATE POLICY identity_app_all ON public.organizations
  TO identity_app
  USING (true)
  WITH CHECK (true);

CREATE POLICY organizations_select_active_member ON public.organizations
  FOR SELECT
  TO authenticated
  USING (identity.is_active_member(id));

CREATE TABLE public.profiles (
  user_id      uuid                     NOT NULL,
  display_name text                     NOT NULL,
  created_at   timestamp with time zone DEFAULT now() NOT NULL,
  updated_at   timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.profiles
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_display_name_check CHECK (char_length(TRIM(BOTH FROM display_name)) >= 1 AND char_length(TRIM(BOTH FROM display_name)) <= 50);

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_pkey PRIMARY KEY (user_id);

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

REVOKE ALL ON public.profiles FROM anon, authenticated;

GRANT INSERT, SELECT, UPDATE ON public.profiles TO authenticated;

GRANT SELECT ON public.profiles TO identity_app;

CREATE POLICY identity_app_all ON public.profiles
  TO identity_app
  USING (true)
  WITH CHECK (true);

CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT
  TO authenticated
  WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY profiles_select_own_or_shared_org ON public.profiles
  FOR SELECT
  TO authenticated
  USING (((user_id = ( SELECT auth.uid() AS uid)) OR identity.shares_active_org(user_id)));

CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE
  TO authenticated
  USING ((user_id = ( SELECT auth.uid() AS uid)))
  WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));