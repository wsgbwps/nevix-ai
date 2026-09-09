import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcChannelMap, IpcEventMap } from '@ipc/channels'
import { EVENT_CHANNEL_ALLOWLIST, INVOKE_CHANNEL_ALLOWLIST } from '../shared/ipc/channel-allowlist'
import {
  CREATION_REFERENCE_MATERIAL_UPLOAD_CANCEL_CHANNEL,
  CREATION_REFERENCE_MATERIAL_UPLOAD_CHANNEL,
  CREATION_REFERENCE_MATERIAL_UPLOAD_PROGRESS_CHANNEL,
  type CreationReferenceMaterialUploadProgress,
  type CreationReferenceMaterialUploadRequest,
  type CreationReferenceMaterialUploadResult
} from '../shared/ipc/creation/types'
import { createCreationUploadBridge } from './creation-upload'

function typedInvoke<K extends keyof IpcChannelMap>(
  channel: K,
  ...args: IpcChannelMap[K] extends { request: infer Req } ? [Req] : []
): Promise<IpcChannelMap[K] extends { response: infer Res } ? Res : void> {
  if (!INVOKE_CHANNEL_ALLOWLIST.has(channel as string)) {
    throw new Error(`IPC invoke channel "${channel as string}" is not allowlisted`)
  }
  return ipcRenderer.invoke(channel as string, ...args) as never
}

function typedOn<K extends keyof IpcEventMap>(
  channel: K,
  listener: (data: IpcEventMap[K]) => void
): () => void {
  if (!EVENT_CHANNEL_ALLOWLIST.has(channel as string)) {
    throw new Error(`IPC event channel "${channel as string}" is not allowlisted`)
  }
  const handler = (_: Electron.IpcRendererEvent, data: IpcEventMap[K]): void => {
    listener(data)
  }
  ipcRenderer.on(channel as string, handler)
  return () => {
    ipcRenderer.removeListener(channel as string, handler)
  }
}

const creation = createCreationUploadBridge({
  getPathForFile: (file) => webUtils.getPathForFile(file),
  invokeUpload: (request: CreationReferenceMaterialUploadRequest) =>
    ipcRenderer.invoke(
      CREATION_REFERENCE_MATERIAL_UPLOAD_CHANNEL,
      request
    ) as Promise<CreationReferenceMaterialUploadResult>,
  invokeCancel: (operationId) =>
    ipcRenderer.invoke(CREATION_REFERENCE_MATERIAL_UPLOAD_CANCEL_CHANNEL, { operationId }),
  onProgress: (listener) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      progress: CreationReferenceMaterialUploadProgress
    ): void => {
      listener(progress)
    }
    ipcRenderer.on(CREATION_REFERENCE_MATERIAL_UPLOAD_PROGRESS_CHANNEL, handler)
    return () =>
      ipcRenderer.removeListener(CREATION_REFERENCE_MATERIAL_UPLOAD_PROGRESS_CHANNEL, handler)
  }
})

const api = { invoke: typedInvoke, on: typedOn, creation }

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-expect-error window.api is declared in index.d.ts for the renderer context
  window.api = api
}
