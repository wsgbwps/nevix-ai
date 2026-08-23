import { app, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  AuditLogExportRequest,
  AuditLogExportResult
} from '../../../shared/ipc/user-management/types'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'

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

/** In E2E mode a configured path replaces the native save dialog so specs can assert the file. */
function resolveE2EOutputPath(): string | undefined {
  if (process.env.NEVIX_E2E !== '1' || app.isPackaged) return undefined
  const configured = process.env.NEVIX_TEST_AUDIT_LOG_EXPORT_PATH
  return configured && configured.length > 0 ? configured : undefined
}

/** In E2E mode a configured delay holds the export in flight so specs can observe its leave semantics. */
function resolveE2ECancelDelayMs(): number | undefined {
  if (process.env.NEVIX_E2E !== '1' || app.isPackaged) return undefined

  const delayMs = Number(process.env.NEVIX_TEST_AUDIT_LOG_CANCEL_DELAY_MS)
  return Number.isInteger(delayMs) && delayMs > 0 && delayMs <= 10_000 ? delayMs : undefined
}

export async function exportAuditLogHandler(
  event: Electron.IpcMainInvokeEvent,
  request: unknown
): Promise<AuditLogExportResult> {
  const ownerWindow = requireTrustedTopLevelRendererSender(
    event,
    'Audit Log export is available only to the trusted renderer'
  )
  const { csv, suggestedFileName } = validateRequest(request)

  const cancelDelayMs = resolveE2ECancelDelayMs()
  if (cancelDelayMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, cancelDelayMs))
    return { saved: false }
  }

  const outputPath = resolveE2EOutputPath()

  if (outputPath) {
    await writeFile(outputPath, csv, 'utf8')
    return { saved: true }
  }

  const saveDialog = await dialog.showSaveDialog(ownerWindow, {
    defaultPath: suggestedFileName,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  })
  if (saveDialog.canceled || !saveDialog.filePath) return { saved: false }

  await writeFile(saveDialog.filePath, csv, 'utf8')
  return { saved: true }
}
