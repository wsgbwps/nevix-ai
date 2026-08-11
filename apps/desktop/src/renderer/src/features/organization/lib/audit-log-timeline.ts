import type { AuditLogEntry } from '../api/audit-logs'

export interface AuditLogDayGroup {
  readonly date: Date
  readonly entries: readonly AuditLogEntry[]
}

export function groupAuditLogEntriesByDay(
  entries: readonly AuditLogEntry[]
): readonly AuditLogDayGroup[] {
  const groups = new Map<string, { date: Date; entries: AuditLogEntry[] }>()

  for (const entry of entries) {
    const date = new Date(entry.createdAt)
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
    const group = groups.get(key)
    if (group) {
      group.entries.push(entry)
    } else {
      groups.set(key, { date, entries: [entry] })
    }
  }

  return [...groups.values()]
}

export function formatAuditLogDay(
  date: Date,
  language: string,
  labels: { readonly today: string; readonly yesterday: string },
  now = new Date()
): string {
  const day = startOfLocalDay(date)
  const currentDay = startOfLocalDay(now)
  const elapsedDays = Math.round((currentDay.getTime() - day.getTime()) / 86_400_000)

  if (elapsedDays === 0) return labels.today
  if (elapsedDays === 1) return labels.yesterday

  return new Intl.DateTimeFormat(language, {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date)
}

export function formatAuditLogTime(date: Date, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}
