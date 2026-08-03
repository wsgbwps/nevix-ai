-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

ALTER TABLE identity.outbox_messages
  ADD COLUMN attempts integer DEFAULT 0 NOT NULL,
  ADD COLUMN next_attempt_at timestamp with time zone DEFAULT now() NOT NULL;

DROP INDEX identity.outbox_messages_pending_idx;

CREATE INDEX outbox_messages_pending_idx ON identity.outbox_messages (next_attempt_at)
  WHERE status = 'pending'::text;
