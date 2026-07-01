import type { IpcChannelMap, IpcEventMap } from '@ipc/channels'

interface TypedApi {
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
