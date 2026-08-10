-- Organization Membership data foundation (identity-org-membership ticket 01).
--
-- The five client-readable tables live in `public` (api.schemas) behind RLS;
-- every write that needs an Audit Log or Outbox row stays a Go trusted
-- command, so organizations, memberships, invitations, and audit_logs are
-- client SELECT-only and the only client-writable table is profiles (own row)
-- — ADR-0008.
--
-- Authorization vocabulary: the three security definer helpers in the
-- `identity` schema are the only place membership authorization is expressed;
-- the RLS policies below are thin references to them.
--
-- EXECUTE privilege deviation from ADR-0008's wording, recorded here and in
-- the migration: PostgreSQL checks EXECUTE on a function against the role
-- that evaluates the RLS policy, so `authenticated` must hold EXECUTE on the
-- helpers for the policies to evaluate at all. `PUBLIC` and `anon` keep no
-- EXECUTE; `anon` additionally holds no table privileges, so it never reaches
-- the helpers. The helpers are unreachable as Data API RPC either way because
-- the `identity` schema is not in api.schemas.

-- Global Profile: one row per User, written by the User themself. The
-- display name is trimmed to 1-50 characters and rejects pure whitespace; it
-- is deliberately not unique. No avatar column in this slice (renderer asset
-- only) — an avatar_path column is a future expand-only move.
CREATE TABLE public.profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  display_name text NOT NULL
    CHECK (char_length(trim(both from display_name)) BETWEEN 1 AND 50),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Organizations are minimal: client-generated id (the CreateOrganization
-- idempotency key), a non-blank name, and timestamps. Status belongs to the
-- Governance slice.
CREATE TABLE public.organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(trim(both from name)) >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Memberships keep their ended rows: rejoining inserts a new row, role
-- changes update in place. "Exactly one active Owner" is enforced by the
-- command transaction plus the partial unique index below.
CREATE TABLE public.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status text NOT NULL CHECK (status IN ('active', 'ended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one active membership per user per organization, and at most one
-- active owner per organization.
CREATE UNIQUE INDEX memberships_active_member_idx
  ON public.memberships (organization_id, user_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX memberships_active_owner_idx
  ON public.memberships (organization_id)
  WHERE role = 'owner' AND status = 'active';

-- Every foreign key and RLS lookup column is indexed: own rows (including
-- ended) are found by user_id, org-scoped lookups by organization_id.
CREATE INDEX memberships_user_id_idx ON public.memberships (user_id);
CREATE INDEX memberships_organization_id_idx
  ON public.memberships (organization_id);

-- Invitations bind a normalized email address to an Organization. Expiration
-- is derived from expires_at rather than materialized as another state: resend
-- keeps the row, resets this deadline, and supersedes its prior code.
CREATE TABLE public.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.organizations (id) ON DELETE CASCADE,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'revoked')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A pending address can be invited to an Organization once. Owner/Admin
-- listings need the organization index across every state; invitee RLS
-- resolves a pending address through the email index.
CREATE UNIQUE INDEX invitations_pending_organization_email_idx
  ON public.invitations (organization_id, email)
  WHERE status = 'pending';
CREATE INDEX invitations_organization_id_idx
  ON public.invitations (organization_id);
CREATE INDEX invitations_pending_email_idx
  ON public.invitations (email)
  WHERE status = 'pending';

-- Audit Log values are immutable snapshots. actor/target identities
-- intentionally have no foreign keys: profile changes or User deletion must
-- not rewrite or erase history. target fields are nullable for actions that
-- affect an Organization rather than a User.
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.organizations (id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  actor_display_name text NOT NULL,
  target_user_id uuid,
  target_display_name text,
  action text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The organization prefix covers both the foreign-key/RLS lookup and the
-- chronological Organization Audit Log read/export path.
CREATE INDEX audit_logs_organization_id_created_at_idx
  ON public.audit_logs (organization_id, created_at DESC);

-- Authorization helpers: security definer so they read memberships regardless
-- of the caller's own visibility, search_path pinned, uid resolved inside the
-- body.
CREATE FUNCTION identity.is_active_member(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE organization_id = p_organization_id
      AND user_id = (select auth.uid())
      AND status = 'active'
  );
$$;

CREATE FUNCTION identity.has_org_role(p_organization_id uuid, p_roles text[])
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE organization_id = p_organization_id
      AND user_id = (select auth.uid())
      AND status = 'active'
      AND role = ANY (p_roles)
  );
$$;

CREATE FUNCTION identity.shares_active_org(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships mine
    JOIN public.memberships theirs
      ON theirs.organization_id = mine.organization_id
     AND theirs.status = 'active'
    WHERE mine.user_id = (select auth.uid())
      AND mine.status = 'active'
      AND theirs.user_id = p_user_id
  );
$$;

-- Email resolution for Go commands only: a read-only window over auth.users,
-- owned by the migration role so grantees need no direct auth.users access.
CREATE VIEW identity.directory AS
  SELECT id, email FROM auth.users;

-- Single Go role for commands, the Outbox Worker, and the retention sweep.
-- No BYPASSRLS: it goes through the permissive policies below so RLS stays
-- the global fallback. Idempotent because db reset replays migrations against
-- a cluster where the role outlives the dropped database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'identity_app') THEN
    CREATE ROLE identity_app LOGIN;
  END IF;
END
$$;

-- The local/ops `postgres` role is not a true superuser, so it needs
-- membership to SET ROLE into identity_app (tests and maintenance).
GRANT identity_app TO postgres;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;


-- profiles: visible to the owner and to active co-members; writable only by
-- the owner.
CREATE POLICY profiles_select_own_or_shared_org ON public.profiles
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()) OR identity.shares_active_org(user_id));
CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (select auth.uid()));
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- organizations: visible to active members.
CREATE POLICY organizations_select_active_member ON public.organizations
  FOR SELECT TO authenticated
  USING (identity.is_active_member(id));

-- memberships: own rows (including ended) plus only the active rows of every
-- organization the caller is actively in; ended rows of co-members stay
-- hidden until a later slice defines who may see them.
CREATE POLICY memberships_select_own_or_active_org ON public.memberships
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid())
    OR (status = 'active' AND identity.is_active_member(organization_id)));

-- invitations: Owner/Admin see every state in their Organization; an invitee
-- sees only their matching pending row. Email normalization belongs to the Go
-- command, so this is an indexed exact comparison against the JWT claim.
CREATE POLICY invitations_select_admin_or_invitee ON public.invitations
  FOR SELECT TO authenticated
  USING (
    identity.has_org_role(organization_id, ARRAY['owner', 'admin'])
    OR (status = 'pending' AND email = ((select auth.jwt()) ->> 'email'))
  );

-- audit_logs: audit visibility stays with Organization administrators.
CREATE POLICY audit_logs_select_owner_or_admin ON public.audit_logs
  FOR SELECT TO authenticated
  USING (identity.has_org_role(organization_id, ARRAY['owner', 'admin']));

-- Permissive access for the Go role; it is the only writer besides the
-- profile owner.
CREATE POLICY identity_app_all ON public.profiles
  FOR ALL TO identity_app USING (true) WITH CHECK (true);
CREATE POLICY identity_app_all ON public.organizations
  FOR ALL TO identity_app USING (true) WITH CHECK (true);
CREATE POLICY identity_app_all ON public.memberships
  FOR ALL TO identity_app USING (true) WITH CHECK (true);
CREATE POLICY identity_app_all ON public.invitations
  FOR ALL TO identity_app USING (true) WITH CHECK (true);
CREATE POLICY identity_app_all ON public.audit_logs
  FOR ALL TO identity_app USING (true) WITH CHECK (true);


-- Client grants: profiles is the only client-writable table. The REVOKEs
-- strip the platform default privileges (MAINTAIN/REFERENCES/TRIGGER/TRUNCATE)
-- that Supabase auto-grants to the API roles on every postgres-created
-- table, so the client ACL is exactly the intentional grants (RLS does not
-- protect TRUNCATE). service_role keeps its platform defaults: it is the
-- stack's server-side trusted role, not a client role.
REVOKE ALL ON public.profiles FROM anon, authenticated;
REVOKE ALL ON public.organizations FROM anon, authenticated;
REVOKE ALL ON public.memberships FROM anon, authenticated;
REVOKE ALL ON public.invitations FROM anon, authenticated;
REVOKE ALL ON public.audit_logs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT ON public.organizations TO authenticated;
GRANT SELECT ON public.memberships TO authenticated;
GRANT SELECT ON public.invitations TO authenticated;
GRANT SELECT ON public.audit_logs TO authenticated;

-- Go role grants: profiles read-only; organizations/memberships read-write
-- without DELETE (Governance owns deletion).
GRANT USAGE ON SCHEMA public TO identity_app;
GRANT SELECT ON public.profiles TO identity_app;
GRANT SELECT, INSERT, UPDATE ON public.organizations TO identity_app;
GRANT SELECT, INSERT, UPDATE ON public.memberships TO identity_app;
GRANT SELECT, INSERT, UPDATE ON public.invitations TO identity_app;
GRANT SELECT, INSERT, DELETE ON public.audit_logs TO identity_app;
GRANT SELECT, INSERT, UPDATE ON identity.verification_codes TO identity_app;
GRANT SELECT, INSERT, UPDATE ON identity.outbox_messages TO identity_app;

-- Helper reachability: authenticated needs EXECUTE to evaluate the policies
-- (see deviation note above); identity_app needs it for future commands.
GRANT USAGE ON SCHEMA identity TO authenticated, identity_app;
GRANT EXECUTE ON FUNCTION
  identity.is_active_member(uuid),
  identity.has_org_role(uuid, text[]),
  identity.shares_active_org(uuid)
  TO authenticated, identity_app;
REVOKE EXECUTE ON FUNCTION
  identity.is_active_member(uuid),
  identity.has_org_role(uuid, text[]),
  identity.shares_active_org(uuid)
  FROM PUBLIC, anon;

-- Directory is Go-only.
GRANT SELECT ON identity.directory TO identity_app;
