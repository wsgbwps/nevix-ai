-- Reauthentication proofs (issue #154, ADR-0016): the exact-action proof an
-- active admin obtains by re-verifying their current password before a
-- high-risk credential command (Provider Connection create/replace/delete in
-- the AI Creation V1 baseline). The proof is a high-entropy opaque token; the
-- client holds only the token body and this table stores only its SHA-256
-- hash. Validity is fixed at five minutes; consumption is one atomic
-- no-restore transition (consumed_at set inside the consuming transaction and
-- never cleared afterwards).
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

CREATE TABLE public.reauth_proofs (
  id          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  user_id     uuid                     NOT NULL,
  action      text                     NOT NULL,
  token_hash  bytea                    NOT NULL,
  expires_at  timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  created_at  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT reauth_proofs_pkey PRIMARY KEY (id),
  CONSTRAINT reauth_proofs_token_hash_key UNIQUE (token_hash),
  CONSTRAINT reauth_proofs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  -- The closed exact-action set is product contract (#154): no other
  -- high-risk action is pre-built, so the database refuses rows for any
  -- action outside it. Extending the set is a deliberate migration plus a
  -- contract change, never silent drift.
  CONSTRAINT reauth_proofs_action_allowed CHECK (
    action IN ('provider_connection.create', 'provider_connection.replace', 'provider_connection.delete')
  )
);

-- FK match index; consumption also filters by the issuing admin, but the
-- unique token_hash index already carries that lookup.
CREATE INDEX reauth_proofs_user_id_idx ON public.reauth_proofs (user_id);

-- The daily sweep deletes expired rows; logical expiry is enforced at
-- consumption, so a failed or delayed sweep never extends validity.
CREATE INDEX reauth_proofs_expires_at_idx ON public.reauth_proofs (expires_at);

-- Least privilege: identity_app issues (INSERT), consumes (UPDATE
-- consumed_at), sweeps (DELETE), and never reads hashes outside matching.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reauth_proofs TO identity_app;
