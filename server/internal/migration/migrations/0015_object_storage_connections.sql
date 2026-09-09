-- The instance's single Object Storage Connection (issue #218). Candidate
-- cloud verification happens before this row is inserted; the active partial
-- unique index is the concurrent-create CAS, while the sequence never reuses a
-- revision after rollback or future termination/recreation.
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

CREATE SEQUENCE public.object_storage_connection_revision_seq;

CREATE TABLE public.object_storage_connections (
  id                         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  provider                   text                     NOT NULL,
  region                     text                     NOT NULL,
  bucket                     text                     NOT NULL,
  revision                   bigint                   NOT NULL DEFAULT nextval('public.object_storage_connection_revision_seq'::regclass),
  state                      text                     NOT NULL,
  envelope_version           integer,
  credential_key_id          text,
  credential_nonce           bytea,
  credential_ciphertext      bytea,
  access_key_id_masked       text                     NOT NULL,
  last_checked_at            timestamp with time zone NOT NULL,
  last_check_outcome         text                     NOT NULL,
  created_by_user_id         uuid                     NOT NULL,
  created_at                 timestamp with time zone NOT NULL DEFAULT now(),
  updated_at                 timestamp with time zone NOT NULL DEFAULT now(),
  terminated_at              timestamp with time zone,
  CONSTRAINT object_storage_connections_pkey PRIMARY KEY (id),
  CONSTRAINT object_storage_connections_revision_key UNIQUE (revision),
  CONSTRAINT object_storage_connections_provider_check CHECK (provider IN ('oss', 'cos')),
  CONSTRAINT object_storage_connections_location_check CHECK (region <> '' AND bucket <> ''),
  CONSTRAINT object_storage_connections_state_check CHECK (state IN ('ready', 'credential_unavailable')),
  CONSTRAINT object_storage_connections_check_outcome_check CHECK (last_check_outcome = 'completed'),
  CONSTRAINT object_storage_connections_envelope_presence_check CHECK (
    (terminated_at IS NULL AND envelope_version IS NOT NULL AND credential_key_id IS NOT NULL AND credential_nonce IS NOT NULL AND credential_ciphertext IS NOT NULL)
    OR (terminated_at IS NOT NULL AND envelope_version IS NULL AND credential_key_id IS NULL AND credential_nonce IS NULL AND credential_ciphertext IS NULL)
  ),
  CONSTRAINT object_storage_connections_created_by_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users (id)
);

CREATE UNIQUE INDEX object_storage_connections_singleton_idx
  ON public.object_storage_connections ((1))
  WHERE terminated_at IS NULL;

CREATE INDEX object_storage_connections_created_by_fk_idx
  ON public.object_storage_connections (created_by_user_id);

GRANT SELECT, INSERT, UPDATE ON public.object_storage_connections TO identity_app;
GRANT USAGE ON SEQUENCE public.object_storage_connection_revision_seq TO identity_app;

ALTER TABLE public.reauth_proofs
  DROP CONSTRAINT reauth_proofs_action_allowed,
  ADD CONSTRAINT reauth_proofs_action_allowed CHECK (
    action IN (
      'provider_connection.create',
      'provider_connection.replace',
      'provider_connection.delete',
      'object_storage_connection.create'
    )
  );
