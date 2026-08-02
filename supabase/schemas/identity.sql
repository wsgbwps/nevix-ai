-- Identity module: transactional Outbox.
-- Lives in the dedicated `identity` schema, which is intentionally NOT listed
-- in api.schemas: rows are written by the Go server inside its own database
-- transactions and claimed by the Outbox Worker; they are never exposed
-- through the Data API.
--
-- Minimal walking-skeleton shape (resend-email-delivery ticket 02). Retry
-- bookkeeping arrives with ticket 03; the identity-v1 schema design ticket
-- absorbs this as an expand-only move.

CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE identity.outbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender text NOT NULL,
  recipient text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The Outbox Worker polls oldest-first for pending rows with
-- FOR UPDATE SKIP LOCKED; a partial index keeps that poll cheap.
CREATE INDEX outbox_messages_pending_idx
  ON identity.outbox_messages (created_at)
  WHERE status = 'pending';
