import { isAbsolute } from 'node:path'
import type {
  CreationReferenceMaterialUploadRequest,
  CreationReferenceMaterialUploadResult
} from '../../../shared/ipc/creation/types'
import { CREATION_REFERENCE_MATERIAL_UPLOAD_PROGRESS_CHANNEL } from '../../../shared/ipc/creation/types'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'
import {
  beginReferenceMaterialUpload,
  endReferenceMaterialUpload
} from '../active-reference-material-uploads'
import { electronReferenceMaterialUploadDependencies } from '../electron-reference-material-upload'
import { runReferenceMaterialUpload } from '../reference-material-upload'

export async function uploadReferenceMaterialHandler(
  event: Electron.IpcMainInvokeEvent,
  rawRequest: unknown
): Promise<CreationReferenceMaterialUploadResult> {
  requireTrustedTopLevelRendererSender(
    event,
    'Reference Material upload is available only to the trusted renderer'
  )
  const request = validateRequest(rawRequest)
  const controller = beginReferenceMaterialUpload(request.operationId)
  if (controller === null) {
    return { outcome: 'request-rejected' as const, code: 'upload_already_active' }
  }
  try {
    return await runReferenceMaterialUpload(
      request,
      electronReferenceMaterialUploadDependencies,
      (sentBytes, totalBytes) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(CREATION_REFERENCE_MATERIAL_UPLOAD_PROGRESS_CHANNEL, {
            operationId: request.operationId,
            sentBytes,
            totalBytes
          })
        }
      },
      controller.signal
    )
  } finally {
    endReferenceMaterialUpload(request.operationId)
  }
}

function validateRequest(raw: unknown): CreationReferenceMaterialUploadRequest {
  if (!isRecord(raw)) throw new Error('Reference Material upload received an invalid request')
  const keys = Object.keys(raw)
  if (
    keys.length !== 7 ||
    typeof raw.operationId !== 'string' ||
    raw.operationId.length === 0 ||
    typeof raw.sessionId !== 'string' ||
    raw.sessionId.length === 0 ||
    typeof raw.localPath !== 'string' ||
    raw.localPath.length === 0 ||
    !isAbsolute(raw.localPath) ||
    typeof raw.fileName !== 'string' ||
    raw.fileName.length === 0 ||
    (raw.declaredKind !== 'image' &&
      raw.declaredKind !== 'video' &&
      raw.declaredKind !== 'audio') ||
    typeof raw.declaredMimeType !== 'string' ||
    raw.declaredMimeType.length === 0 ||
    typeof raw.declaredByteSize !== 'number' ||
    !Number.isSafeInteger(raw.declaredByteSize) ||
    raw.declaredByteSize <= 0
  ) {
    throw new Error('Reference Material upload received an invalid request')
  }
  return raw as unknown as CreationReferenceMaterialUploadRequest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
