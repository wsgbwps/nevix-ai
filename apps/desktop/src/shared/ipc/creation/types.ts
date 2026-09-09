export type CreationMaterialKind = 'image' | 'video' | 'audio'

export interface CreationReferenceMaterial {
  readonly id: string
  readonly kind: CreationMaterialKind
  readonly fileName: string
  readonly mimeType: string
  readonly byteSize: number
  readonly widthPx: number | null
  readonly heightPx: number | null
  readonly pixelCount: number | null
  readonly durationMs: number | null
  readonly checksumSha256: string
  readonly claimsVersion: number
  readonly createdAt: string
}

export type CreationReferenceMaterialUploadResult =
  | { readonly outcome: 'succeeded'; readonly value: CreationReferenceMaterial }
  | { readonly outcome: 'network-failure' }
  | { readonly outcome: 'unauthorized' }
  | { readonly outcome: 'forbidden' }
  | { readonly outcome: 'request-rejected'; readonly code: string }

export type CreationReferenceMaterialUploadAbortResult =
  | { readonly outcome: 'succeeded'; readonly value: CreationReferenceMaterial | null }
  | { readonly outcome: 'network-failure' }
  | { readonly outcome: 'unauthorized' }
  | { readonly outcome: 'forbidden' }
  | { readonly outcome: 'request-rejected'; readonly code: string }

export interface CreationReferenceMaterialUploadRequest {
  readonly operationId: string
  readonly idempotencyKey: string
  readonly sessionId: string
  readonly localPath: string
  readonly fileName: string
  readonly declaredKind: CreationMaterialKind
  readonly declaredMimeType: string
  readonly declaredByteSize: number
}

export interface CreationReferenceMaterialUploadRecovery {
  readonly uploadId?: string
  readonly idempotencyKey: string
  readonly sessionId: string
  readonly fileName: string
  readonly declaredKind: CreationMaterialKind
  readonly declaredMimeType: string
  readonly declaredByteSize: number
  readonly putExpiresAt?: string
  readonly finalizeExpiresAt?: string
}

export interface CreationReferenceMaterialUploadRecoveryRequest {
  readonly operationId: string
  readonly recovery: CreationReferenceMaterialUploadRecovery
}

export interface CreationReferenceMaterialUploadLease {
  readonly operationId: string
  readonly recovery: Required<CreationReferenceMaterialUploadRecovery>
}

export interface CreationReferenceMaterialUploadProgress {
  readonly operationId: string
  readonly sentBytes: number
  readonly totalBytes: number
}

export const CREATION_REFERENCE_MATERIAL_UPLOAD_CHANNEL =
  'creation:upload-reference-material' as const
export const CREATION_REFERENCE_MATERIAL_UPLOAD_CANCEL_CHANNEL =
  'creation:cancel-reference-material-upload' as const
export const CREATION_REFERENCE_MATERIAL_UPLOAD_PROGRESS_CHANNEL =
  'creation:reference-material-upload-progress' as const
export const CREATION_REFERENCE_MATERIAL_UPLOAD_LEASE_CHANNEL =
  'creation:reference-material-upload-lease' as const
export const CREATION_REFERENCE_MATERIAL_UPLOAD_RECOVER_CHANNEL =
  'creation:recover-reference-material-upload' as const
export const CREATION_REFERENCE_MATERIAL_UPLOAD_ABORT_CHANNEL =
  'creation:abort-reference-material-upload' as const

export interface CreationNativeUploadApi {
  uploadReferenceMaterial(
    operationId: string,
    sessionId: string,
    file: File,
    onProgress?: (progress: Omit<CreationReferenceMaterialUploadProgress, 'operationId'>) => void,
    options?: {
      readonly idempotencyKey: string
      readonly onLease?: (recovery: Required<CreationReferenceMaterialUploadRecovery>) => void
    }
  ): Promise<CreationReferenceMaterialUploadResult>
  recoverReferenceMaterialUpload(
    operationId: string,
    recovery: CreationReferenceMaterialUploadRecovery
  ): Promise<CreationReferenceMaterialUploadResult>
  abortReferenceMaterialUpload(
    operationId: string,
    recovery: CreationReferenceMaterialUploadRecovery
  ): Promise<CreationReferenceMaterialUploadAbortResult>
  cancelReferenceMaterialUpload(operationId: string): Promise<void>
}
