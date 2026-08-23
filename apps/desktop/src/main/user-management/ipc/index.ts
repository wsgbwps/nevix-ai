import { ipcMain } from 'electron'
import { exportAuditLogHandler } from './export-audit-log'

export function register(): void {
  ipcMain.handle('user-management:export-audit-log', exportAuditLogHandler)
}
