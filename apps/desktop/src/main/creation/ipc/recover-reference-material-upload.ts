import type {
  CreationReferenceMaterialUploadRecovery,
  CreationReferenceMaterialUploadRecoveryRequest,
  CreationReferenceMaterialUploadResult
} from '../../../shared/ipc/creation/types'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'
import {
  beginReferenceMaterialUpload,
  endReferenceMaterialUpload
} from '../active-reference-material-uploads'
import { electronReferenceMaterialUploadDependencies } from '../electron-reference-material-upload'
import { recoverReferenceMaterialUpload } from '../reference-material-upload'
import { isCanonicalUuid } from './reference-material-upload-validation'

export async function recoverReferenceMaterialUploadHandler(
  event: Electron.IpcMainInvokeEvent,
  rawRecovery: unknown
): Promise<CreationReferenceMaterialUploadResult> {
  requireTrustedTopLevelRendererSender(
    event,
    'Reference Material upload recovery is available only to the trusted renderer'
  )
  const request = validateReferenceMaterialUploadRecoveryRequest(rawRecovery)
  const controller = beginReferenceMaterialUpload(request.operationId)
  if (controller === null) {
    return { outcome: 'request-rejected', code: 'upload_already_active' }
  }
  try {
    return await recoverReferenceMaterialUpload(
      request.recovery,
      electronReferenceMaterialUploadDependencies,
      controller.signal
    )
  } finally {
    endReferenceMaterialUpload(request.operationId)
  }
}

export function validateReferenceMaterialUploadRecoveryRequest(
  raw: unknown
): CreationReferenceMaterialUploadRecoveryRequest {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 2 ||
    !nonempty(raw.operationId) ||
    !('recovery' in raw)
  ) {
    throw new Error('Reference Material upload recovery received an invalid request')
  }
  return { operationId: raw.operationId, recovery: validateRecovery(raw.recovery) }
}

function validateRecovery(raw: unknown): CreationReferenceMaterialUploadRecovery {
  if (!isRecord(raw)) throw new Error('Reference Material upload recovery received invalid facts')
  const allowed = new Set([
    'uploadId',
    'idempotencyKey',
    'sessionId',
    'fileName',
    'declaredKind',
    'declaredMimeType',
    'declaredByteSize',
    'putExpiresAt',
    'finalizeExpiresAt'
  ])
  const serverFacts = [raw.uploadId, raw.putExpiresAt, raw.finalizeExpiresAt]
  const hasNoServerFacts = serverFacts.every((value) => value === undefined)
  const hasAllServerFacts =
    isCanonicalUuid(raw.uploadId) && nonempty(raw.putExpiresAt) && nonempty(raw.finalizeExpiresAt)
  if (
    Object.keys(raw).some((key) => !allowed.has(key)) ||
    !nonempty(raw.idempotencyKey) ||
    !isCanonicalUuid(raw.sessionId) ||
    !nonempty(raw.fileName) ||
    (raw.declaredKind !== 'image' &&
      raw.declaredKind !== 'video' &&
      raw.declaredKind !== 'audio') ||
    !nonempty(raw.declaredMimeType) ||
    typeof raw.declaredByteSize !== 'number' ||
    !Number.isSafeInteger(raw.declaredByteSize) ||
    raw.declaredByteSize <= 0 ||
    (!hasNoServerFacts && !hasAllServerFacts)
  ) {
    throw new Error('Reference Material upload recovery received invalid facts')
  }
  return raw as unknown as CreationReferenceMaterialUploadRecovery
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
