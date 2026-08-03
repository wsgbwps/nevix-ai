-- Identity module: transactional Outbox.
-- Lives in the dedicated `identity` schema, which is intentionally NOT listed
-- in api.schemas: rows are written by the Go server inside its own database
-- transactions and claimed by the Outbox Worker; they are never exposed
-- through the Data API.
--
-- Minimal walking-skeleton shape (resend-email-delivery ticket 02) plus the
-- retry bookkeeping of ticket 03: attempts counts delivery attempts and
-- next_attempt_at gates when a pending row may be claimed again. The
-- identity-v1 schema design ticket absorbs this as an expand-only move.

CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE identity.outbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender text NOT NULL,
  recipient text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The Outbox Worker polls due pending rows oldest-first with
-- FOR UPDATE SKIP LOCKED; a partial index keeps that poll cheap.
CREATE INDEX outbox_messages_pending_idx
  ON identity.outbox_messages (next_attempt_at)
  WHERE status = 'pending';

-- One-time verification codes (resend-email-delivery ticket 04). The command
-- layer issues six-digit codes, stores only their HMAC hash, and supersedes
-- the previous code on resend. Every accepted issuance writes exactly one
-- row carrying the requester's IP, so this table is also the rate-limit
-- record: the 60-second resend cooldown, the five-codes-per-email-hour cap,
-- and the per-IP hourly cap all read it, and a rejected command writes
-- nothing. Minimal expand-move shape; the identity-v1 schema design ticket
-- absorbs it together with the Outbox table above.
CREATE TABLE identity.verification_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code_hash text NOT NULL,
  request_ip text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);

-- The rate-limit and cooldown checks count recent rows per email and per
-- request IP; both lookups are by issuer and creation time.
CREATE INDEX verification_codes_email_created_idx
  ON identity.verification_codes (email, created_at);
CREATE INDEX verification_codes_request_ip_created_idx
  ON identity.verification_codes (request_ip, created_at);
