import type { SlotResultView } from '../api/generation-task-http'

/**
 * The single naming convention for a task slot's verified output — the name
 * the download button writes to disk and the name a dragged result carries
 * when re-uploaded as reference material (ADR-0018), so the same bytes keep
 * the same name in both places. The extension follows the actual MIME type
 * (the vendor commonly returns JPEG), never a fixed png.
 */
const resultExtensions: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4'
}

export function resultFilename(
  taskId: string,
  index: number,
  mediaType: 'image' | 'video',
  mimeType: string | null
): string {
  const extension =
    (mimeType !== null ? resultExtensions[mimeType] : undefined) ??
    (mediaType === 'video' ? 'mp4' : 'png')
  return `nevix-${taskId.slice(0, 8)}-${index + 1}.${extension}`
}

export function slotResultFilename(
  taskId: string,
  index: number,
  mediaType: 'image' | 'video',
  result: SlotResultView | null
): string {
  return resultFilename(taskId, index, mediaType, result?.mimeType ?? null)
}
