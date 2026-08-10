-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

CREATE INDEX outbox_messages_pending_verification_code_idx ON identity.outbox_messages (verification_code_id)
  WHERE status = 'pending'::text AND verification_code_id IS NOT NULL;

CREATE INDEX verification_codes_action_target_created_idx ON identity.verification_codes (target_id, created_at DESC)
  WHERE action_type IS NOT NULL;