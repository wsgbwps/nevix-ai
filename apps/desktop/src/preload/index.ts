import { contextBridge, ipcRenderer } from 'electron'
import type { IpcChannelMap, IpcEventMap } from '@ipc/channels'
import { EVENT_CHANNEL_ALLOWLIST, INVOKE_CHANNEL_ALLOWLIST } from '../shared/ipc/channel-allowlist'

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

const api = { invoke: typedInvoke, on: typedOn }

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-expect-error window.api is declared in index.d.ts for the renderer context
  window.api = api
}
