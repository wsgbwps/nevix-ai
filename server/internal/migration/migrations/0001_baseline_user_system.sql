-- Baseline for the single-tenant user system (ADR-0015). This is the
-- drop-rebuild of the schema world: no production data exists, so the
-- multi-organization legacy objects are torn down destructively where they
-- still exist and the new world — users, sessions, and the
-- organization-free audit log — is created in their place. No RLS is
-- created: with no client-side database access there is no policy
-- evaluation subject (ADR-0015).
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

-- Legacy teardown, idempotent against both a fresh cluster and one still
-- carrying the Supabase-era schema (DROP ... IF EXISTS never fails on a
-- fresh database; CASCADE follows the foreign-key web of the old world).
DROP SCHEMA IF EXISTS identity CASCADE;
DROP TABLE IF EXISTS public.outbox_messages CASCADE;
DROP TABLE IF EXISTS public.invitations CASCADE;
DROP TABLE IF EXISTS public.memberships CASCADE;
DROP TABLE IF EXISTS public.organizations CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;
DROP TABLE IF EXISTS public.verification_codes CASCADE;
DROP TABLE IF EXISTS public.audit_logs CASCADE;

-- The only PostgreSQL role Server writes may run as: a LOGIN role with the
-- table grants below and nothing else. No password is part of the migration;
-- deployment provisioning (and the test harness) owns credentials. Idempotent
-- so a re-run against a cluster where the role already exists still succeeds.
-- StatementBegin/End fence the block's embedded semicolons from Goose's
-- statement splitter.
-- +goose StatementBegin
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'identity_app') THEN
    CREATE ROLE identity_app LOGIN;
  END IF;
END
$$;
-- +goose StatementEnd

-- The bundled Postgres `postgres` user is a true superuser, but keep role
-- membership explicit so maintenance and tests can SET ROLE identity_app on
-- any standard deployment.
GRANT identity_app TO postgres;

CREATE TABLE public.users (
  id                   uuid                     NOT NULL DEFAULT gen_random_uuid(),
  email                text                     NOT NULL,
  password_hash        text                     NOT NULL,
  display_name         text                     NOT NULL,
  role                 text                     NOT NULL,
  status               text                     NOT NULL,
  must_change_password boolean                  NOT NULL DEFAULT false,
  created_at           timestamp with time zone NOT NULL DEFAULT now(),
  updated_at           timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_role_check CHECK (role = ANY (ARRAY['admin'::text, 'member'::text])),
  CONSTRAINT users_status_check CHECK (status = ANY (ARRAY['active'::text, 'disabled'::text]))
);

CREATE TABLE public.sessions (
  id           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  user_id      uuid                     NOT NULL,
  token_hash   bytea                    NOT NULL,
  device_name  text                     NOT NULL DEFAULT ''::text,
  created_at   timestamp with time zone NOT NULL DEFAULT now(),
  last_used_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at   timestamp with time zone NOT NULL,
  CONSTRAINT sessions_pkey PRIMARY KEY (id),
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- Session lookups are by token hash (every guarded request) and by user
-- (revocation cascades); the sweeper deletes by expiry.
CREATE INDEX sessions_user_id_idx ON public.sessions (user_id);

CREATE INDEX sessions_expires_at_idx ON public.sessions (expires_at);

CREATE TABLE public.audit_logs (
  id                  uuid                     NOT NULL DEFAULT gen_random_uuid(),
  actor_user_id       uuid                     NOT NULL,
  actor_display_name  text                     NOT NULL,
  target_user_id      uuid,
  target_display_name text,
  action              text                     NOT NULL,
  metadata            jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_pkey PRIMARY KEY (id)
);

-- Audit pagination is newest-first (ADR-0009 revision: read via Go API).
CREATE INDEX audit_logs_created_at_idx ON public.audit_logs (created_at DESC);

-- Least-privilege grants (ADR-0015): identity_app maintains users and
-- sessions, appends and sweeps the audit log, and never holds UPDATE on
-- audit rows — immutability by grant, not by trigger (ADR-0009).
GRANT USAGE ON SCHEMA public TO identity_app;

GRANT SELECT, INSERT, UPDATE ON public.users TO identity_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO identity_app;

GRANT SELECT, INSERT, DELETE ON public.audit_logs TO identity_app;
