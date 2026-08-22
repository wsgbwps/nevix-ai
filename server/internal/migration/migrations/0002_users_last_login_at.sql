-- Issue #102: the users table gains last_login_at, written in the same
-- transaction that issues a session at login. NULL is the durable
-- "never logged in" marker admin deletion keys on: audit rows age out of the
-- 365-day retention window and sessions can be revoked, so neither of those
-- can answer "has this account ever logged in"; only a column on the account
-- row can (ADR-0009 retention, ADR-0015 lifecycle rules).
--
-- Up-only (ADR-0013): no Down section is ever provided.

-- +goose Up

ALTER TABLE public.users ADD COLUMN last_login_at timestamp with time zone;

-- The column is also management-list display state ("last seen"), and the
-- admin lifecycle gains its first deletable accounts: issue #102 opens
-- deletion of never-logged-in accounts, which the baseline's least-
-- privilege grants never needed. The grant stays on this migration so the
-- capability arrives with the feature, not silently earlier.
GRANT DELETE ON public.users TO identity_app;
