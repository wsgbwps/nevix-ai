import type { AuditLogEntry } from '../api/audit-logs'

/**
 * Invitation events use their immutable recipient email as the timeline and export target. Some
 * events also snapshot a User target, so the email must take precedence when both are present.
 */
export function auditLogTargetDisplayName(entry: AuditLogEntry): string | null {
  if (entry.action.startsWith('invitation_')) {
    const email = entry.metadata.email
    if (typeof email === 'string' && email.trim().length > 0) return email
  }

  return entry.targetDisplayName
}
