-- Join codes (ADR-0015 2026-08-23 revision, issue #120): the admin-issued
-- registration credential for member self-registration. A code is a shared,
-- reusable secret — it is not consumed by registration; only revocation
-- (UPDATE revoked_at) ends it, and with no active code self-registration is
-- closed, which is why no separate registration toggle exists. The plaintext
-- code is stored deliberately: anyone who can read the database could write
-- public.users directly, so plaintext storage costs no real security
-- (ADR-0015 Considered Options).
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

CREATE TABLE public.join_codes (
  id         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  code       text                     NOT NULL,
  label      text                     NOT NULL DEFAULT ''::text,
  created_by uuid                     NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  revoked_at timestamp with time zone,
  CONSTRAINT join_codes_pkey PRIMARY KEY (id),
  CONSTRAINT join_codes_code_key UNIQUE (code),
  CONSTRAINT join_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id)
);

-- The admin list reads the active set (revoked_at IS NULL); the active cap of
-- 3 is enforced by the service inside the create transaction, which locks
-- these same rows FOR UPDATE so concurrent creates serialize against the cap.
CREATE INDEX join_codes_active_idx ON public.join_codes (created_at DESC) WHERE revoked_at IS NULL;

-- Least privilege: the app role issues (INSERT), lists (SELECT), and revokes
-- (UPDATE revoked_at). No DELETE — a revoked code row is the audit-corroborating
-- record that the code once existed, and revocation is the only lifecycle end.
GRANT SELECT, INSERT, UPDATE ON public.join_codes TO identity_app;
