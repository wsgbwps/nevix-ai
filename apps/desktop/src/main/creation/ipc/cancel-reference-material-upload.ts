import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'
import { cancelReferenceMaterialUpload } from '../active-reference-material-uploads'

export function cancelReferenceMaterialUploadHandler(
  event: Electron.IpcMainInvokeEvent,
  rawRequest: unknown
): void {
  requireTrustedTopLevelRendererSender(
    event,
    'Reference Material upload cancellation is available only to the trusted renderer'
  )
  const keys = isRecord(rawRequest) ? Object.keys(rawRequest) : []
  const operationId = isRecord(rawRequest) ? rawRequest.operationId : undefined
  if (keys.length !== 1 || typeof operationId !== 'string' || operationId.length === 0) {
    throw new Error('Reference Material upload cancellation received an invalid request')
  }
  cancelReferenceMaterialUpload(operationId)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
