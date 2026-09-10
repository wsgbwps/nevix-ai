import type { CreationReferenceMaterialUploadAbortResult } from '../../../shared/ipc/creation/types'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'
import {
  beginReferenceMaterialUpload,
  endReferenceMaterialUpload
} from '../active-reference-material-uploads'
import { electronReferenceMaterialUploadDependencies } from '../electron-reference-material-upload'
import { abortReferenceMaterialUploadRecovery } from '../reference-material-upload'
import { validateReferenceMaterialUploadRecoveryRequest } from './recover-reference-material-upload'

export async function abortReferenceMaterialUploadHandler(
  event: Electron.IpcMainInvokeEvent,
  rawRequest: unknown
): Promise<CreationReferenceMaterialUploadAbortResult> {
  requireTrustedTopLevelRendererSender(
    event,
    'Reference Material upload abort is available only to the trusted renderer'
  )
  const request = validateReferenceMaterialUploadRecoveryRequest(rawRequest)
  const controller = beginReferenceMaterialUpload(request.operationId)
  if (controller === null) {
    return { outcome: 'request-rejected', code: 'upload_already_active' }
  }
  try {
    return await abortReferenceMaterialUploadRecovery(
      request.recovery,
      electronReferenceMaterialUploadDependencies,
      controller.signal
    )
  } finally {
    endReferenceMaterialUpload(request.operationId)
  }
}
