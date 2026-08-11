import { app, dialog, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  AuditLogExportRequest,
  AuditLogExportResult
} from '../../../shared/ipc/organization/types'
import { requireTrustedRendererSender } from './trusted-sender'

function validateRequest(request: unknown): AuditLogExportRequest {
  const keys = typeof request === 'object' && request !== null ? Object.keys(request) : []
  const value = request as { csv?: unknown; suggestedFileName?: unknown }
  if (
    keys.length !== 2 ||
    typeof value.csv !== 'string' ||
    value.csv.length === 0 ||
    typeof value.suggestedFileName !== 'string' ||
    value.suggestedFileName.length === 0 ||
    value.suggestedFileName !== basename(value.suggestedFileName) ||
    !value.suggestedFileName.endsWith('.csv')
  ) {
    throw new Error('Audit Log export received an invalid file payload')
  }
  return { csv: value.csv, suggestedFileName: value.suggestedFileName }
}

function testOutputPath(): string | undefined {
  if (process.env.NEVIX_E2E !== '1' || app.isPackaged) return undefined
  const outputPath = process.env.NEVIX_TEST_AUDIT_LOG_EXPORT_PATH
  return outputPath && outputPath.length > 0 ? outputPath : undefined
}

export async function exportAuditLogHandler(
  event: Electron.IpcMainInvokeEvent,
  request: unknown
): Promise<AuditLogExportResult> {
  requireTrustedRendererSender(event)
  const { csv, suggestedFileName } = validateRequest(request)
  const outputPath = testOutputPath()

  if (outputPath) {
    await writeFile(outputPath, csv, 'utf8')
    return { saved: true }
  }

  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  if (!ownerWindow) throw new Error('Audit Log export has no owning window')

  const saveDialog = await dialog.showSaveDialog(ownerWindow, {
    defaultPath: suggestedFileName,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  })
  if (saveDialog.canceled || !saveDialog.filePath) return { saved: false }

  await writeFile(saveDialog.filePath, csv, 'utf8')
  return { saved: true }
}
