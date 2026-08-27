/**
 * The Audit Log action vocabulary the Desktop presents with localized
 * labels (ADR-0009: the schema keeps action as text and the server's single
 * writer validates it; this list is the presentation mirror). Adding a
 * server action without its mirror here degrades the Admin list and CSV to
 * raw machine codes — the unit test keeps the mirror and both translations
 * in lockstep.
 */
export const AUDIT_ACTION_KEYS = [
  'instance_claimed',
  'session_created',
  'session_revoked',
  'password_changed',
  'display_name_changed',
  'user_created',
  'user_disabled',
  'user_password_reset',
  'user_email_changed',
  'user_role_changed',
  'user_deleted',
  'join_code_created',
  'join_code_revoked',
  'user_self_registered',
  'reauth_proof_issued',
  'reauth_proof_consumed',
  'provider_connection_created',
  'provider_connection_replaced',
  'provider_connection_paused',
  'provider_connection_resumed',
  'provider_connection_checked',
  'provider_connection_deleted'
] as const

// NOTE: user_self_registered (issue #121) is included because the same
// localized-surface contract applies; it had been missed when the register
// feature landed and is completed together with this slice's two reauth
// actions rather than left degrading the Admin list to a raw machine code.

export type AuditActionKey = (typeof AUDIT_ACTION_KEYS)[number]

export function isAuditActionKey(action: string): action is AuditActionKey {
  return (AUDIT_ACTION_KEYS as readonly string[]).includes(action)
}
