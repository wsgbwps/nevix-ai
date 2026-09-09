import type { IpcChannelMap, IpcEventMap } from '@ipc/channels'
import type { CreationNativeUploadApi } from '../shared/ipc/creation/types'

interface TypedApi {
  readonly creation: CreationNativeUploadApi

  invoke<K extends keyof IpcChannelMap>(
    channel: K,
    ...args: IpcChannelMap[K] extends { request: infer Req } ? [Req] : []
  ): Promise<IpcChannelMap[K] extends { response: infer Res } ? Res : void>

  on<K extends keyof IpcEventMap>(channel: K, listener: (data: IpcEventMap[K]) => void): () => void
}

declare global {
  interface Window {
    api: TypedApi
  }
}
