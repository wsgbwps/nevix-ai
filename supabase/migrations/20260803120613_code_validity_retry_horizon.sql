-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

ALTER TABLE identity.outbox_messages
  DROP CONSTRAINT outbox_messages_status_check;

ALTER TABLE identity.outbox_messages
  ADD CONSTRAINT outbox_messages_status_check CHECK (status = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text, 'cancelled'::text]));

ALTER TABLE identity.outbox_messages
  ADD COLUMN verification_code_id uuid;

ALTER TABLE identity.outbox_messages
  ADD CONSTRAINT outbox_messages_verification_code_id_fkey FOREIGN KEY (verification_code_id) REFERENCES identity.verification_codes(id);

ALTER TABLE identity.verification_codes
  ADD COLUMN expires_at timestamp with time zone NOT NULL;