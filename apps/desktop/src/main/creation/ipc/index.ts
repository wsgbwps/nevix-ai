import { ipcMain } from 'electron'
import {
  CREATION_REFERENCE_MATERIAL_UPLOAD_ABORT_CHANNEL,
  CREATION_REFERENCE_MATERIAL_UPLOAD_CANCEL_CHANNEL,
  CREATION_REFERENCE_MATERIAL_UPLOAD_CHANNEL,
  CREATION_REFERENCE_MATERIAL_UPLOAD_RECOVER_CHANNEL
} from '../../../shared/ipc/creation/types'
import { abortReferenceMaterialUploadHandler } from './abort-reference-material-upload'
import { cancelReferenceMaterialUploadHandler } from './cancel-reference-material-upload'
import { uploadReferenceMaterialHandler } from './upload-reference-material'
import { recoverReferenceMaterialUploadHandler } from './recover-reference-material-upload'

export function register(): void {
  ipcMain.handle(CREATION_REFERENCE_MATERIAL_UPLOAD_CHANNEL, uploadReferenceMaterialHandler)
  ipcMain.handle(
    CREATION_REFERENCE_MATERIAL_UPLOAD_RECOVER_CHANNEL,
    recoverReferenceMaterialUploadHandler
  )
  ipcMain.handle(
    CREATION_REFERENCE_MATERIAL_UPLOAD_ABORT_CHANNEL,
    abortReferenceMaterialUploadHandler
  )
  ipcMain.handle(
    CREATION_REFERENCE_MATERIAL_UPLOAD_CANCEL_CHANNEL,
    cancelReferenceMaterialUploadHandler
  )
}
