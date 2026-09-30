import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DownloadIcon, PencilLineIcon, RefreshCwIcon } from 'lucide-react'
import type { GenerationSlotView, GenerationTaskDetail } from '../api/generation-task-http'
import { isTerminalTaskStatus } from '../api/generation-task-http'
import type { WorkbenchComposerHandle, WorkbenchGalleryHandle } from '../model/use-workbench'
import { slotResultFilename } from '../lib/result-filename'
import { AssetDetailPreview, AssetPreviewAction } from './asset-detail-preview'
import { ImageWithSkeleton, VideoWithSkeleton } from './media-with-skeleton'

/** Page-owned result display; virtualized slot cards can release their own leases. */
export function WorkbenchResultPreview({
  detail,
  slotIndex,
  title,
  gallery,
  loadMaterialPreviewSource,
  notices,
  onSelectSlot,
  onClose,
  onOpenTask
}: {
  readonly detail: GenerationTaskDetail
  readonly slotIndex: number
  readonly title: string
  readonly gallery: WorkbenchGalleryHandle
  readonly loadMaterialPreviewSource: WorkbenchComposerHandle['loadMaterialPreviewSource']
  readonly notices?: React.ReactNode
  readonly onSelectSlot: (index: number) => void
  readonly onClose: () => void
  readonly onOpenTask: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation('creation')
  const task = detail.task
  const slots = detail.slots.filter(
    (slot) => slot.status === 'succeeded' && slot.resultDeleted !== true
  )
  const selected = slots.find((slot) => slot.index === slotIndex)
  const { retainMaterialThumbnail, requestMaterialThumbnail } = gallery
  const references =
    detail.specification?.references.map(
      (_, index) => detail.referenceMaterials?.[index] ?? null
    ) ?? []
  const loadReferencePreview = useCallback(
    async (id: string): Promise<{ url: string; release?: () => void } | null> => {
      const source = await loadMaterialPreviewSource(id)
      if (source === null) return null
      if (!(source instanceof File)) return { url: source.url }
      const url = URL.createObjectURL(source)
      return { url, release: () => URL.revokeObjectURL(url) }
    },
    [loadMaterialPreviewSource]
  )

  useEffect(() => {
    const releases = (detail.referenceMaterials ?? []).flatMap((material) => {
      if (material?.kind !== 'image') return []
      const release = retainMaterialThumbnail(material.id)
      requestMaterialThumbnail(material.id)
      return [release]
    })
    return () => releases.forEach((release) => release())
  }, [detail.referenceMaterials, retainMaterialThumbnail, requestMaterialThumbnail])

  if (selected === undefined) return null
  const editFailed =
    gallery.reeditAction?.taskId === task.id && gallery.reeditAction.status === 'failed'
  const download = (): void => {
    void gallery
      .acquireResultBlobUrl(task.id, selected.index)
      .then((lease) => {
        if (lease === null) return
        const anchor = document.createElement('a')
        anchor.href = lease.url
        anchor.download = slotResultFilename(
          task.id,
          selected.index,
          task.mediaType,
          selected.result
        )
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        window.setTimeout(lease.release, 0)
      })
      .catch(() => undefined)
  }

  return (
    <AssetDetailPreview
      open
      title={title}
      onClose={onClose}
      specification={detail.specification}
      references={references}
      loadReferencePreview={loadReferencePreview}
      referenceThumbnails={gallery.thumbnails}
      origin={{ taskId: task.id, name: title, onOpen: onOpenTask }}
      selectedResultId={String(selected.index)}
      onSelectResult={(id) => onSelectSlot(Number(id))}
      results={slots.map((slot) => ({
        id: String(slot.index),
        label: t('assets.result', { n: slot.index + 1 }),
        media: (
          <ResultPreviewMedia
            key={`${task.id}-${slot.index}`}
            taskId={task.id}
            slot={slot}
            mediaType={task.mediaType}
            acquire={gallery.acquireResultBlobUrl}
            thumbnail
          />
        )
      }))}
      media={
        <ResultPreviewMedia
          key={`${task.id}-${selected.index}`}
          taskId={task.id}
          slot={selected}
          mediaType={task.mediaType}
          acquire={gallery.acquireResultBlobUrl}
        />
      }
      headerActions={
        <AssetPreviewAction icon={<DownloadIcon aria-hidden />} onClick={download}>
          {t('gallery.actions.download')}
        </AssetPreviewAction>
      }
      metadata={
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[10px]">
          <dt className="text-muted-foreground">{t('gallery.details.createdAt')}</dt>
          <dd>{new Date(task.createdAt).toLocaleString()}</dd>
          <dt className="text-muted-foreground">{t('assets.details.type')}</dt>
          <dd>{t(`assets.media.${task.mediaType}`)}</dd>
          {selected.result !== null && (
            <>
              <dt className="text-muted-foreground">{t('assets.details.size')}</dt>
              <dd>{Math.ceil(selected.result.byteSize / 1024)} KB</dd>
              {selected.result.widthPx !== null && selected.result.heightPx !== null && (
                <>
                  <dt className="text-muted-foreground">{t('assets.details.dimensions')}</dt>
                  <dd>
                    {selected.result.widthPx} × {selected.result.heightPx}
                  </dd>
                </>
              )}
              {selected.result.durationMs !== null && (
                <>
                  <dt className="text-muted-foreground">{t('assets.details.outputDuration')}</dt>
                  <dd>{t('assets.details.seconds', { n: selected.result.durationMs / 1000 })}</dd>
                </>
              )}
            </>
          )}
        </dl>
      }
      actions={
        <>
          <AssetPreviewAction
            icon={<PencilLineIcon />}
            disabled={
              detail.specification === null ||
              (gallery.reeditAction?.taskId === task.id &&
                gallery.reeditAction.status === 'loading')
            }
            onClick={() => {
              void gallery.reeditTask(task.id).then((restored) => {
                if (!restored) return
                onClose()
                requestAnimationFrame(() => document.getElementById('composer-prompt')?.focus())
              })
            }}
          >
            {t('gallery.actions.reedit')}
          </AssetPreviewAction>
          {isTerminalTaskStatus(task.status) && (
            <AssetPreviewAction
              icon={<RefreshCwIcon />}
              disabled={detail.specification === null || gallery.regenerateDisabled}
              onClick={() => gallery.regenerate(task.id)}
            >
              {t('gallery.actions.regenerate')}
            </AssetPreviewAction>
          )}
        </>
      }
      messages={
        <>
          {notices}
          {editFailed && <p role="alert">{t('gallery.actions.reeditFailed')}</p>}
          {gallery.taskDetailStaleIds.has(task.id) && (
            <p role="status">{t('gallery.detailStale')}</p>
          )}
        </>
      }
    />
  )
}

function ResultPreviewMedia({
  taskId,
  slot,
  mediaType,
  acquire,
  thumbnail = false
}: {
  readonly taskId: string
  readonly slot: GenerationSlotView
  readonly mediaType: 'image' | 'video'
  readonly acquire: WorkbenchGalleryHandle['acquireResultBlobUrl']
  readonly thumbnail?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const [attempt, setAttempt] = useState(0)
  const [source, setSource] = useState<{ url: string | null; failed: boolean }>({
    url: null,
    failed: false
  })
  useEffect(() => {
    let active = true
    let release: (() => void) | undefined
    void acquire(taskId, slot.index)
      .then((lease) => {
        if (!active) {
          lease?.release()
          return
        }
        release = lease?.release
        setSource({ url: lease?.url ?? null, failed: lease === null })
      })
      .catch(() => {
        if (active) setSource({ url: null, failed: true })
      })
    return () => {
      active = false
      release?.()
    }
  }, [acquire, attempt, slot.index, taskId])
  if (source.failed) {
    return (
      <div className="text-muted-foreground grid size-full place-content-center gap-2 text-center text-xs">
        <p role="alert">{t('gallery.media.failed')}</p>
        {!thumbnail && (
          <button
            type="button"
            onClick={() => {
              setSource({ url: null, failed: false })
              setAttempt((value) => value + 1)
            }}
            className="hover:bg-accent rounded-md border px-3 py-2"
          >
            {t('gallery.media.retry')}
          </button>
        )}
      </div>
    )
  }
  const mediaClass = `size-full ${thumbnail ? 'object-cover' : 'object-contain'}`
  const onError = (): void => setSource({ url: null, failed: true })
  return mediaType === 'image' || source.url === null ? (
    <ImageWithSkeleton
      src={source.url}
      alt={thumbnail ? '' : t('gallery.resultAlt')}
      loadingLabel={String(t('gallery.media.loading'))}
      className={mediaClass}
      onError={onError}
    />
  ) : (
    <VideoWithSkeleton
      src={source.url}
      controls={!thumbnail}
      loadingLabel={String(t('gallery.media.loading'))}
      className={mediaClass}
      onError={onError}
    />
  )
}
