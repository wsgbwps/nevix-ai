-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

CREATE SCHEMA identity AUTHORIZATION postgres;

CREATE TABLE identity.outbox_messages (
  id         uuid                     DEFAULT gen_random_uuid() NOT NULL,
  sender     text                     NOT NULL,
  recipient  text                     NOT NULL,
  subject    text                     NOT NULL,
  body       text                     NOT NULL,
  status     text                     DEFAULT 'pending'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE identity.outbox_messages
  ADD CONSTRAINT outbox_messages_pkey PRIMARY KEY (id);

ALTER TABLE identity.outbox_messages
  ADD CONSTRAINT outbox_messages_status_check CHECK (status = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text]));

CREATE INDEX outbox_messages_pending_idx ON identity.outbox_messages (created_at)
  WHERE status = 'pending'::text;