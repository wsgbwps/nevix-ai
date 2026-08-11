import type { AuditLogEntry } from '../api/audit-logs'

/**
 * Invitation writes intentionally have no User target, because the invitee may not yet have an
 * account. Their immutable metadata contains the recipient email, which is the timeline target.
 */
export function auditLogTargetDisplayName(entry: AuditLogEntry): string | null {
  if (entry.targetDisplayName) return entry.targetDisplayName
  if (!entry.action.startsWith('invitation_')) return null

  const email = entry.metadata.email
  return typeof email === 'string' && email.trim().length > 0 ? email : null
}
