import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DownloadIcon } from 'lucide-react'
import type { GenerationSlotView } from '../api/generation-task-http'
import type { ResultBlobUrlLease } from '../lib/result-blob-cache'
import { slotResultFilename } from '../lib/result-filename'
import {
  RESULT_DRAG_MIME,
  beginResultDrag,
  encodeResultDrag,
  endResultDrag
} from '../model/reference-drop'
import { actionKey, diagnosticSourceKey, reasonKey, statusKey } from '../i18n/gallery-keys'
import { Skeleton } from '../../../components/ui/skeleton'
import { ImageWithSkeleton, VideoWithSkeleton } from './media-with-skeleton'

export function SlotCard({
  acquireResultBlobUrl,
  taskId,
  slot,
  mediaType,
  aspectRatio,
  mediaKey,
  onMediaSettled
}: {
  readonly acquireResultBlobUrl: (
    taskId: string,
    slotIndex: number
  ) => Promise<ResultBlobUrlLease | null>
  readonly taskId: string
  readonly slot: GenerationSlotView
  readonly mediaType: 'image' | 'video'
  readonly aspectRatio: number
  readonly mediaKey: string
  readonly onMediaSettled: (mediaKey: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const [mediaAttempt, setMediaAttempt] = useState(0)
  const [media, setMedia] = useState<
    | { readonly status: 'unloaded' | 'failed'; readonly url: null }
    | { readonly status: 'loading'; readonly url: string | null }
    | { readonly status: 'ready'; readonly url: string }
  >({ status: 'unloaded', url: null })
  const succeeded = slot.status === 'succeeded'

  // A mounted slot leases its URL. Virtualization can then unmount old cards
  // and let the byte-budgeted cache evict them without revoking a URL that is
  // still painted by another consumer.
  useEffect(() => {
    if (!succeeded) return
    let active = true
    let release: (() => void) | null = null
    queueMicrotask(() => {
      if (active) setMedia({ status: 'loading', url: null })
    })
    void acquireResultBlobUrl(taskId, slot.index)
      .then((lease) => {
        if (!active) {
          lease?.release()
          return
        }
        if (lease === null) {
          setMedia({ status: 'failed', url: null })
          onMediaSettled(mediaKey)
          return
        }
        release = lease.release
        setMedia({ status: 'loading', url: lease.url })
      })
      .catch(() => {
        if (active) {
          setMedia({ status: 'failed', url: null })
          onMediaSettled(mediaKey)
        }
      })
    return () => {
      active = false
      release?.()
    }
  }, [
    acquireResultBlobUrl,
    mediaAttempt,
    mediaKey,
    mediaType,
    onMediaSettled,
    slot.index,
    succeeded,
    taskId
  ])

  const download = (): void => {
    void acquireResultBlobUrl(taskId, slot.index)
      .then((lease) => {
        if (lease === null) return
        const anchor = document.createElement('a')
        anchor.href = lease.url
        anchor.download = slotResultFilename(taskId, slot.index, mediaType, slot.result)
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        window.setTimeout(lease.release, 0)
      })
      .catch(() => undefined)
  }

  // A succeeded slot is the drag source for reference reuse (ADR-0018): the
  // custom type identifies the slot at drop time, while the module record
  // carries the payload through dragover's protected mode. The native ghost
  // would be the whole gallery cell, far larger than the deck cards it
  // hovers — a 48x64 offscreen twin (the deck card's size) keeps the drop
  // target visible while dragging.
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const dragStart = (event: React.DragEvent<HTMLDivElement>): void => {
    const payload = { taskId, slotIndex: slot.index, mediaType }
    beginResultDrag(payload)
    event.dataTransfer.setData(RESULT_DRAG_MIME, encodeResultDrag(payload))
    event.dataTransfer.effectAllowed = 'copy'
    const ghost = document.createElement('div')
    ghost.style.cssText =
      'position:fixed;top:-200px;left:-200px;z-index:-1;width:48px;height:64px;overflow:hidden;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.4);background:var(--muted)'
    const source = event.currentTarget.querySelector('img')
    if (source !== null) {
      const face = document.createElement('img')
      face.src = source.src
      face.style.cssText = 'width:100%;height:100%;object-fit:cover'
      ghost.appendChild(face)
    } else {
      const face = document.createElement('span')
      face.style.cssText =
        'display:grid;place-items:center;width:100%;height:100%;color:var(--muted-foreground);font-size:18px'
      face.textContent = mediaType === 'video' ? '▶' : 'IMG'
      ghost.appendChild(face)
    }
    document.body.appendChild(ghost)
    ghostRef.current = ghost
    event.dataTransfer.setDragImage(ghost, 24, 32)
  }

  const dragEnd = (): void => {
    endResultDrag()
    ghostRef.current?.remove()
    ghostRef.current = null
  }
  const mediaUrl = media.url

  return (
    <div
      data-testid={`slot-${taskId}-${slot.index}`}
      data-slot-status={slot.status}
      data-media-state={succeeded ? media.status : undefined}
      role={succeeded ? undefined : 'status'}
      aria-label={String(t(statusKey(slot.status)))}
      draggable={succeeded}
      onDragStart={(event) => {
        if (succeeded) dragStart(event)
        else event.preventDefault()
      }}
      onDragEnd={dragEnd}
      style={{ aspectRatio: String(aspectRatio) }}
      className="bg-foreground/[0.04] relative overflow-hidden rounded-lg"
    >
      {succeeded && mediaUrl !== null ? (
        mediaType === 'image' ? (
          <ImageWithSkeleton
            src={mediaUrl}
            alt={t('gallery.resultAlt')}
            loadingLabel={String(t('gallery.media.loading'))}
            className="size-full object-cover"
            onLoad={() => {
              setMedia({ status: 'ready', url: mediaUrl })
              onMediaSettled(mediaKey)
            }}
            onError={() => {
              setMedia({ status: 'failed', url: null })
              onMediaSettled(mediaKey)
            }}
          />
        ) : (
          <VideoWithSkeleton
            src={mediaUrl}
            controls
            loadingLabel={String(t('gallery.media.loading'))}
            className="size-full object-cover"
            onLoadedData={() => {
              setMedia({ status: 'ready', url: mediaUrl })
              onMediaSettled(mediaKey)
            }}
            onError={() => {
              setMedia({ status: 'failed', url: null })
              onMediaSettled(mediaKey)
            }}
          />
        )
      ) : succeeded && media.status === 'failed' ? (
        <span className="absolute inset-0 grid place-content-center justify-items-center gap-2 p-2 text-center text-[10px]">
          <span role="alert" className="text-muted-foreground">
            {t('gallery.media.failed')}
          </span>
          <button
            type="button"
            onClick={() => setMediaAttempt((attempt) => attempt + 1)}
            className="border-border hover:bg-accent rounded-md border px-2 py-1"
          >
            {t('gallery.media.retry')}
          </button>
        </span>
      ) : succeeded ? (
        <>
          <Skeleton aria-hidden className="absolute inset-0 size-full rounded-none" />
          <span role="status" className="sr-only">
            {t('gallery.media.loading')}
          </span>
        </>
      ) : (
        <span className="absolute inset-0 flex overflow-y-auto p-2">
          <span className="text-muted-foreground my-auto w-full text-center text-[10px] leading-4">
            {t(statusKey(slot.status))}
            {slot.failureReason !== null && (
              <span className="block">{t(reasonKey(slot.failureReason))}</span>
            )}
            {slot.actionSuggestion != null && (
              <span className="mt-1 block font-medium">{t(actionKey(slot.actionSuggestion))}</span>
            )}
            {slot.retryable != null && (
              <span className="block">
                {t(slot.retryable ? 'gallery.guidance.retryable' : 'gallery.guidance.notRetryable')}
              </span>
            )}
            {slot.supportNumber != null && (
              <span className="block font-mono break-all">
                {t('gallery.guidance.supportNumber')}: {slot.supportNumber}
              </span>
            )}
            {slot.failureDiagnostic != null && (
              <span
                className="border-border/70 mt-1 block border-t pt-1 text-left break-words"
                data-testid={`slot-diagnostic-${taskId}-${slot.index}`}
              >
                <span className="block font-medium">
                  {t(diagnosticSourceKey(slot.failureDiagnostic.source))}
                </span>
                <span className="block font-mono">
                  {slot.failureDiagnostic.code}
                  {slot.failureDiagnostic.providerType !== null
                    ? ` · ${slot.failureDiagnostic.providerType}`
                    : ''}
                  {slot.failureDiagnostic.httpStatus !== null
                    ? ` · HTTP ${slot.failureDiagnostic.httpStatus}`
                    : ''}
                </span>
                <span className="block">{slot.failureDiagnostic.message}</span>
                {slot.failureDiagnostic.requestId !== null && (
                  <span className="block font-mono">
                    {t('gallery.diagnostic.requestId')}: {slot.failureDiagnostic.requestId}
                  </span>
                )}
              </span>
            )}
          </span>
        </span>
      )}
      {succeeded && (
        <button
          type="button"
          data-testid={`slot-download-${taskId}-${slot.index}`}
          aria-label={String(t('gallery.actions.download'))}
          title={slotResultFilename(taskId, slot.index, mediaType, slot.result)}
          onClick={download}
          className="absolute right-1 bottom-1 z-10 grid size-6 place-items-center rounded-md border border-white/25 bg-black/50 text-white outline-none hover:bg-black/65 focus-visible:ring-2 focus-visible:ring-sky-400/70"
        >
          <DownloadIcon className="size-3" aria-hidden />
        </button>
      )}
    </div>
  )
}
