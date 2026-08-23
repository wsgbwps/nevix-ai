import type { AuditLogEntry } from '../api/client'

export interface AuditLogCsvColumns {
  readonly time: string
  readonly actor: string
  readonly action: string
  readonly target: string
  readonly metadata: string
}

/** The suggested export file name: product-constant prefix plus a local timestamp. */
export function auditLogExportFileName(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `nevix-audit-log-${stamp}.csv`
}

/**
 * Serializes audit entries as CSV with CRLF rows and spreadsheet-formula
 * protection; every cell value comes from server snapshots, but display names
 * are still user-typed text, so the guard applies to the whole row.
 */
export function serializeAuditLogCsv(
  entries: readonly AuditLogEntry[],
  columns: AuditLogCsvColumns,
  actionLabel: (action: string) => string
): string {
  const rows = [
    [columns.time, columns.actor, columns.action, columns.target, columns.metadata],
    ...entries.map((entry) => [
      entry.createdAt,
      entry.actorDisplayName,
      actionLabel(entry.action),
      entry.targetDisplayName ?? '',
      JSON.stringify(entry.metadata)
    ])
  ]

  return `${rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')}\r\n`
}

function escapeCsvCell(value: string): string {
  const safeValue = protectSpreadsheetFormula(value)
  return /[",\r\n]/.test(safeValue) ? `"${safeValue.replaceAll('"', '""')}"` : safeValue
}

function protectSpreadsheetFormula(value: string): string {
  return /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value
}
