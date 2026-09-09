const activeUploads = new Map<string, AbortController>()

export function beginReferenceMaterialUpload(operationId: string): AbortController | null {
  if (activeUploads.has(operationId)) return null
  const controller = new AbortController()
  activeUploads.set(operationId, controller)
  return controller
}

export function endReferenceMaterialUpload(operationId: string): void {
  activeUploads.delete(operationId)
}

export function cancelReferenceMaterialUpload(operationId: string): void {
  activeUploads.get(operationId)?.abort()
}
