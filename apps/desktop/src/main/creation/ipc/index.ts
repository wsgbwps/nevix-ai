import { ipcMain } from 'electron'
import {
  CREATION_REFERENCE_MATERIAL_UPLOAD_CANCEL_CHANNEL,
  CREATION_REFERENCE_MATERIAL_UPLOAD_CHANNEL
} from '../../../shared/ipc/creation/types'
import { cancelReferenceMaterialUploadHandler } from './cancel-reference-material-upload'
import { uploadReferenceMaterialHandler } from './upload-reference-material'

export function register(): void {
  ipcMain.handle(CREATION_REFERENCE_MATERIAL_UPLOAD_CHANNEL, uploadReferenceMaterialHandler)
  ipcMain.handle(
    CREATION_REFERENCE_MATERIAL_UPLOAD_CANCEL_CHANNEL,
    cancelReferenceMaterialUploadHandler
  )
}
