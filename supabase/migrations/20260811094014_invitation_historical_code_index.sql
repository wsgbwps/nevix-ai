-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

CREATE INDEX verification_codes_invitation_superseded_hash_idx ON identity.verification_codes (target_id, code_hash)
  WHERE action_type = 'invitation'::text AND status = 'superseded'::text;