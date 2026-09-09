import type {
  CreationMaterialKind,
  CreationNativeUploadApi,
  CreationReferenceMaterialUploadAbortResult,
  CreationReferenceMaterialUploadLease,
  CreationReferenceMaterialUploadProgress,
  CreationReferenceMaterialUploadRecoveryRequest,
  CreationReferenceMaterialUploadRequest,
  CreationReferenceMaterialUploadResult
} from '../shared/ipc/creation/types'

interface CreationUploadBridgeDependencies {
  readonly getPathForFile: (file: File) => string
  readonly invokeUpload: (
    request: CreationReferenceMaterialUploadRequest
  ) => Promise<CreationReferenceMaterialUploadResult>
  readonly invokeCancel: (operationId: string) => Promise<void>
  readonly invokeRecover: (
    request: CreationReferenceMaterialUploadRecoveryRequest
  ) => Promise<CreationReferenceMaterialUploadResult>
  readonly invokeAbort: (
    request: CreationReferenceMaterialUploadRecoveryRequest
  ) => Promise<CreationReferenceMaterialUploadAbortResult>
  readonly onProgress: (
    listener: (progress: CreationReferenceMaterialUploadProgress) => void
  ) => () => void
  readonly onLease: (listener: (lease: CreationReferenceMaterialUploadLease) => void) => () => void
}

export function createCreationUploadBridge(
  dependencies: CreationUploadBridgeDependencies
): CreationNativeUploadApi {
  return {
    async uploadReferenceMaterial(operationId, sessionId, file, onProgress, options) {
      if (!(file instanceof File)) {
        return { outcome: 'request-rejected', code: 'invalid_local_file' }
      }
      let localPath: string
      try {
        const resolvedPath: unknown = dependencies.getPathForFile(file)
        if (typeof resolvedPath !== 'string') {
          return { outcome: 'request-rejected', code: 'invalid_local_file' }
        }
        localPath = resolvedPath
      } catch {
        return { outcome: 'request-rejected', code: 'invalid_local_file' }
      }
      const declaredKind = materialKind(file.type)
      if (
        localPath.length === 0 ||
        sessionId.length === 0 ||
        file.name.length === 0 ||
        file.type.length === 0 ||
        !Number.isSafeInteger(file.size) ||
        file.size <= 0 ||
        declaredKind === null
      ) {
        return { outcome: 'request-rejected', code: 'invalid_local_file' }
      }

      const releaseProgress = dependencies.onProgress((progress) => {
        if (progress.operationId !== operationId) return
        onProgress?.({ sentBytes: progress.sentBytes, totalBytes: progress.totalBytes })
      })
      const releaseLease = dependencies.onLease((lease) => {
        if (lease.operationId !== operationId) return
        options?.onLease?.(lease.recovery)
      })
      try {
        return await dependencies.invokeUpload({
          operationId,
          idempotencyKey: options?.idempotencyKey ?? operationId,
          sessionId,
          localPath,
          fileName: file.name,
          declaredKind,
          declaredMimeType: file.type,
          declaredByteSize: file.size
        })
      } finally {
        releaseProgress()
        releaseLease()
      }
    },
    recoverReferenceMaterialUpload: (operationId, recovery) =>
      dependencies.invokeRecover({ operationId, recovery }),
    abortReferenceMaterialUpload: (operationId, recovery) =>
      dependencies.invokeAbort({ operationId, recovery }),
    async cancelReferenceMaterialUpload(operationId) {
      if (operationId.length === 0) return
      await dependencies.invokeCancel(operationId)
    }
  }
}

function materialKind(mimeType: string): CreationMaterialKind | null {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return null
}
