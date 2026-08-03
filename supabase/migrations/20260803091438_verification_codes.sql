-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

CREATE TABLE identity.verification_codes (
  id            uuid                     DEFAULT gen_random_uuid() NOT NULL,
  email         text                     NOT NULL,
  code_hash     text                     NOT NULL,
  request_ip    text                     NOT NULL,
  status        text                     DEFAULT 'active'::text NOT NULL,
  created_at    timestamp with time zone DEFAULT now() NOT NULL,
  superseded_at timestamp with time zone
);

ALTER TABLE identity.verification_codes
  ADD CONSTRAINT verification_codes_pkey PRIMARY KEY (id);

ALTER TABLE identity.verification_codes
  ADD CONSTRAINT verification_codes_status_check CHECK (status = ANY (ARRAY['active'::text, 'superseded'::text]));

CREATE INDEX verification_codes_email_created_idx ON identity.verification_codes (email, created_at);

CREATE INDEX verification_codes_request_ip_created_idx ON identity.verification_codes (request_ip, created_at);