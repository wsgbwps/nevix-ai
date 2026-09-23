import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DownloadIcon, WandSparklesIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../components/ui/dialog'
import type {
  InspirationDetailView,
  InspirationItem,
  InspirationPorts,
  PublicationView
} from '../api/inspiration-http'
import type { MediaAssetView, RestrictionState } from '../api/asset-library-http'
import { useInspiration, type InspirationFilters } from '../model/use-inspiration'
import { AssetMedia, type MediaPreviewView } from './asset-media'
import { LoadMoreSentinel } from './load-more-sentinel'
import type { AssetDisplayPort } from './use-asset-display'

const mediaTypes = ['image', 'video'] as const
const initialFilters: InspirationFilters = { mediaType: 'image' }
const gap = 2
const minimumColumnWidth = 170
const columnHeightTolerance = 12

export interface InspirationPageProps {
  readonly ports: InspirationPorts
  readonly onCreateSimilar: (
    publicationId: string
  ) => Promise<'prepared' | 'failed' | 'unavailable'>
}

function itemMedia(item: InspirationItem): MediaPreviewView & {
  /** The download's own metadata: display never reads it. */
  readonly mimeType: string
  readonly byteSize: number
  readonly widthPx: number | null
  readonly heightPx: number | null
} {
  return item.type === 'publication' ? item.publication : item.asset
}

function itemId(item: InspirationItem): string {
  return item.type === 'publication' ? item.publication.id : item.asset.id
}

function sameItem(left: InspirationItem | null, right: InspirationItem | null): boolean {
  return (
    left !== null && right !== null && left.type === right.type && itemId(left) === itemId(right)
  )
}

function itemCreator(item: InspirationItem): string {
  return item.type === 'publication'
    ? item.publication.publisher.displayName
    : item.asset.creator.displayName
}

function itemDate(item: InspirationItem): string {
  return item.type === 'publication' ? item.publication.publishedAt : item.asset.createdAt
}

function publicationFor(
  item: InspirationItem,
  detail?: InspirationDetailView | null
): PublicationView | null {
  if (item.type === 'publication') {
    return detail?.type === 'publication' && detail.publication.id === item.publication.id
      ? detail.publication
      : item.publication
  }
  return detail?.type === 'asset' ? detail.publication : null
}

function mediaPort(ports: InspirationPorts, item: InspirationItem): AssetDisplayPort {
  return {
    loadAssetDisplay: (_id, purpose, options) =>
      ports.loadInspirationDisplay(item, purpose, options)
  }
}

function saveBlob(item: InspirationItem, blob: Blob): void {
  const media = itemMedia(item)
  const extension = media.mimeType.split('/')[1]?.split(/[;+]/)[0] || 'bin'
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `inspiration-${itemId(item)}.${extension}`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function InspirationCard({
  item,
  ports,
  style,
  onOpen,
  onUnavailable
}: {
  readonly item: InspirationItem
  readonly ports: InspirationPorts
  readonly style: React.CSSProperties
  readonly onOpen: () => void
  readonly onUnavailable: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const media = itemMedia(item)
  const contentPort = useMemo(() => mediaPort(ports, item), [item, ports])
  // As in `AssetCard`: the open button covers the media, so hover is tracked on
  // the card rather than on the element.
  const [hovered, setHovered] = useState(false)
  return (
    <li data-testid="inspiration-card" className="group absolute overflow-hidden" style={style}>
      <div
        className="bg-muted relative size-full overflow-hidden"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <AssetMedia
          asset={media}
          ports={contentPort}
          hovered={hovered}
          onUnavailable={onUnavailable}
        />
        {item.type === 'asset' ? (
          <div className="pointer-events-none absolute top-2 right-2 z-20 flex gap-1 text-[10px] font-semibold text-white">
            <span className="rounded bg-black/70 px-1.5 py-0.5">
              {item.asset.publication
                ? t('inspiration.status.published')
                : t('inspiration.status.unpublished')}
            </span>
            {item.asset.restrictionState === 'active' ||
            item.asset.publication?.restrictionState === 'active' ? (
              <span className="rounded bg-red-700/90 px-1.5 py-0.5">
                {t('inspiration.status.restricted')}
              </span>
            ) : item.asset.restrictionState === 'released' ||
              item.asset.publication?.restrictionState === 'released' ? (
              <span className="rounded bg-slate-700/90 px-1.5 py-0.5">
                {t('inspiration.status.released')}
              </span>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('inspiration.open', { id: itemId(item) })}
          className="focus-visible:ring-ring absolute inset-0 z-10 outline-none focus-visible:ring-2 focus-visible:ring-inset"
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent p-2 pt-10 text-white opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <div className="flex items-end justify-between gap-2 text-[11px]">
            <span className="truncate font-medium">{itemCreator(item)}</span>
            <time className="shrink-0" dateTime={itemDate(item)}>
              {new Date(itemDate(item)).toLocaleDateString()}
            </time>
          </div>
        </div>
      </div>
    </li>
  )
}

function RestrictionControl({
  kind,
  state,
  canRestrict,
  canRelease,
  running,
  onRestrict,
  onRelease
}: {
  readonly kind: 'asset' | 'publication'
  readonly state: RestrictionState
  readonly canRestrict: boolean
  readonly canRelease: boolean
  readonly running: boolean
  readonly onRestrict: () => void
  readonly onRelease: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation('creation')
  if (!canRestrict && !canRelease) return null
  return (
    <section
      aria-label={t(`inspiration.restriction.${kind}.label`)}
      className="min-w-[12rem] rounded-md border p-2 text-xs"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="font-medium">{t(`inspiration.restriction.${kind}.label`)}</h3>
        <span className="text-muted-foreground">
          {t(`inspiration.restriction.state.${state ?? 'none'}`)}
        </span>
      </div>
      {canRestrict ? (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={running}
          onClick={onRestrict}
        >
          {t(`inspiration.restriction.${kind}.restrict`)}
        </Button>
      ) : null}
      {canRelease ? (
        <Button type="button" size="sm" variant="outline" disabled={running} onClick={onRelease}>
          {t(`inspiration.restriction.${kind}.release`)}
        </Button>
      ) : null}
    </section>
  )
}

type RestrictionTarget = 'asset' | 'publication'
type RestrictionOperation = 'restrict' | 'release'

function InspirationWall({
  items,
  ports,
  onOpen,
  onUnavailable
}: {
  readonly items: readonly InspirationItem[]
  readonly ports: InspirationPorts
  readonly onOpen: (item: InspirationItem) => void
  readonly onUnavailable: () => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const update = (): void => setWidth(host.getBoundingClientRect().width)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const layout = useMemo(() => {
    if (width <= 0) return { height: 0, cards: [] as React.CSSProperties[] }
    const columns = Math.min(6, Math.max(2, Math.floor((width + gap) / minimumColumnWidth)))
    const cardWidth = (width - gap * (columns - 1)) / columns
    const heights = Array.from({ length: columns }, () => 0)
    const cards = items.map((item) => {
      const media = itemMedia(item)
      const ratio =
        media.widthPx && media.heightPx && media.widthPx > 0 && media.heightPx > 0
          ? media.widthPx / media.heightPx
          : 4 / 3
      const height = Math.max(112, cardWidth / ratio)
      const shortestHeight = Math.min(...heights)
      const column = heights.findIndex(
        (columnHeight) => columnHeight <= shortestHeight + columnHeightTolerance
      )
      const top = heights[column]
      heights[column] += height + gap
      return { left: column * (cardWidth + gap), top, width: cardWidth, height }
    })
    return { height: Math.max(...heights, 0) - gap, cards }
  }, [items, width])

  return (
    <div ref={hostRef} className="w-full" data-testid="inspiration-wall">
      <ul
        className="relative overflow-hidden rounded-xl"
        style={{ height: Math.max(0, layout.height) }}
      >
        {items.map((item, index) => (
          <InspirationCard
            key={`${item.type}:${itemId(item)}`}
            item={item}
            ports={ports}
            style={layout.cards[index] ?? {}}
            onOpen={() => onOpen(item)}
            onUnavailable={onUnavailable}
          />
        ))}
      </ul>
    </div>
  )
}

function DetailFacts({
  detail,
  item,
  ports
}: {
  readonly detail: InspirationDetailView
  readonly item: InspirationItem
  readonly ports: InspirationPorts
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const specification = detail.specification
  const [previews, setPreviews] = useState<ReadonlyMap<string, string>>(new Map())
  const refreshedPreviews = useRef(new Set<string>())
  const [previewFailed, setPreviewFailed] = useState<string | null>(null)
  const authorizePreview = (referenceId: string): void => {
    setPreviewFailed(null)
    void ports.loadInspirationReferencePreview(item, referenceId).then((result) => {
      if (result.outcome !== 'succeeded') {
        setPreviews((current) => {
          const next = new Map(current)
          next.delete(referenceId)
          return next
        })
        setPreviewFailed(referenceId)
        return
      }
      setPreviews((current) => new Map(current).set(referenceId, result.value.url))
    })
  }
  const refreshPreview = (referenceId: string): void => {
    if (refreshedPreviews.current.has(referenceId)) {
      setPreviews((current) => {
        const next = new Map(current)
        next.delete(referenceId)
        return next
      })
      setPreviewFailed(referenceId)
      return
    }
    refreshedPreviews.current.add(referenceId)
    authorizePreview(referenceId)
  }
  return (
    <div className="space-y-4 text-xs">
      <section className="space-y-2">
        <h3 className="font-medium">{t('inspiration.specification')}</h3>
        <p className="whitespace-pre-wrap">{specification.prompt}</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">{t('inspiration.schemaVersion')}</dt>
          <dd>{specification.schemaVersion}</dd>
          <dt className="text-muted-foreground">{t('assets.details.type')}</dt>
          <dd>{t(`assets.media.${specification.mediaType}`)}</dd>
          <dt className="text-muted-foreground">{t('gallery.details.mode')}</dt>
          <dd>{specification.mode}</dd>
          <dt className="text-muted-foreground">{t('composer.model.label')}</dt>
          <dd className="truncate">{specification.model}</dd>
          <dt className="text-muted-foreground">{t('inspiration.manifestVersion')}</dt>
          <dd>{specification.manifestVersion}</dd>
          <dt className="text-muted-foreground">{t('composer.params.ratio')}</dt>
          <dd>{specification.ratio || '—'}</dd>
          <dt className="text-muted-foreground">{t('composer.params.resolution')}</dt>
          <dd>{specification.resolution || '—'}</dd>
          <dt className="text-muted-foreground">{t('gallery.details.quantity')}</dt>
          <dd>{specification.quantity}</dd>
          <dt className="text-muted-foreground">{t('gallery.details.duration')}</dt>
          <dd>
            {specification.durationSeconds === null
              ? '—'
              : t('assets.details.seconds', { n: specification.durationSeconds })}
          </dd>
        </dl>
      </section>
      <section className="space-y-2 border-t pt-4">
        <h3 className="font-medium">{t('inspiration.references')}</h3>
        {detail.references.length === 0 ? (
          <p className="text-muted-foreground">{t('inspiration.noReferences')}</p>
        ) : (
          <ol className="space-y-2">
            {detail.references.map((reference, index) => (
              <li key={reference.id} className="rounded-md border p-2">
                <p className="truncate font-medium">
                  {index + 1}. {reference.fileName}
                </p>
                <p className="text-muted-foreground">
                  {t(
                    `gallery.role.${reference.role === 'first_frame' ? 'firstFrame' : reference.role === 'last_frame' ? 'lastFrame' : reference.role}`
                  )}
                  {' · '}
                  {reference.kind} ·{' '}
                  {t('inspiration.claimsVersion', { version: reference.claimsVersion })}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="mt-1"
                  onClick={() => {
                    refreshedPreviews.current.delete(reference.id)
                    authorizePreview(reference.id)
                  }}
                >
                  {t('inspiration.previewReference')}
                </Button>
                {previews.get(reference.id) ? (
                  reference.kind === 'image' ? (
                    <img
                      src={previews.get(reference.id)}
                      alt={reference.fileName}
                      className="mt-2 max-h-40 w-full rounded object-contain"
                      onError={() => refreshPreview(reference.id)}
                      onLoad={() => refreshedPreviews.current.delete(reference.id)}
                    />
                  ) : reference.kind === 'video' ? (
                    <video
                      src={previews.get(reference.id)}
                      aria-label={reference.fileName}
                      controls
                      className="mt-2 max-h-40 w-full"
                      onError={() => refreshPreview(reference.id)}
                      onLoadedData={() => refreshedPreviews.current.delete(reference.id)}
                    />
                  ) : (
                    <audio
                      src={previews.get(reference.id)}
                      aria-label={reference.fileName}
                      controls
                      className="mt-2 w-full"
                      onError={() => refreshPreview(reference.id)}
                      onLoadedData={() => refreshedPreviews.current.delete(reference.id)}
                    />
                  )
                ) : null}
                {previewFailed === reference.id ? (
                  <p className="text-destructive mt-1" role="alert">
                    {t('inspiration.previewFailed')}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

function InspirationDetail({
  item,
  detail,
  status,
  ports,
  actionStatus,
  actionMessage,
  onClose,
  onDownload,
  onCreateSimilar,
  onWithdraw,
  onRestriction,
  onUnavailable
}: {
  readonly item: InspirationItem | null
  readonly detail: InspirationDetailView | null
  readonly status: 'idle' | 'loading' | 'failed'
  readonly ports: InspirationPorts
  readonly actionStatus: 'idle' | 'running' | 'succeeded' | 'failed'
  readonly actionMessage: string | null
  readonly onClose: () => void
  readonly onDownload: () => void
  readonly onCreateSimilar: () => void
  readonly onWithdraw: () => void
  readonly onRestriction: (target: RestrictionTarget, operation: RestrictionOperation) => void
  /** The resource answered gone or forbidden: this page's facts are stale. */
  readonly onUnavailable: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const media = item ? itemMedia(item) : null
  const contentPort = useMemo(() => (item ? mediaPort(ports, item) : null), [item, ports])
  const publication = item ? publicationFor(item, detail) : null
  const asset: MediaAssetView | null = detail?.type === 'asset' ? detail.asset : null
  const running = actionStatus === 'running'
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="h-[calc(100svh-2rem)] max-h-[52rem] overflow-hidden p-0 sm:max-w-[min(76rem,calc(100%-2rem))]">
        <DialogHeader className="sr-only">
          <DialogTitle>{t('inspiration.detailTitle')}</DialogTitle>
          <DialogDescription>{t('inspiration.detailDescription')}</DialogDescription>
        </DialogHeader>
        {status === 'loading' ? (
          <p className="p-8" role="status">
            {t('inspiration.loadingDetail')}
          </p>
        ) : status === 'failed' || !detail || !item || !media || !contentPort ? (
          <p className="p-8" role="alert">
            {t('inspiration.detailFailed')}
          </p>
        ) : (
          <div className="grid size-full min-h-0 min-[800px]:grid-cols-[minmax(0,1fr)_22.5rem]">
            <div className="bg-muted grid min-h-56 min-w-0 place-items-center overflow-hidden p-4">
              <AssetMedia asset={media} ports={contentPort} detail onUnavailable={onUnavailable} />
            </div>
            <div className="flex min-h-0 min-w-0 flex-col border-t min-[800px]:border-t-0 min-[800px]:border-l">
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                <DetailFacts
                  key={`${item.type}:${itemId(item)}`}
                  detail={detail}
                  item={item}
                  ports={ports}
                />
              </div>
              <DialogFooter className="flex-row flex-wrap justify-start border-t p-4 sm:justify-start">
                <Button type="button" variant="outline" onClick={onDownload}>
                  <DownloadIcon aria-hidden />
                  {t('assets.download')}
                </Button>
                {publication?.capabilities.canCreateSimilar ? (
                  <Button type="button" disabled={running} onClick={onCreateSimilar}>
                    <WandSparklesIcon aria-hidden />
                    {t('assets.createSimilar')}
                  </Button>
                ) : null}
                {publication?.capabilities.canWithdraw ? (
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={running}
                    onClick={onWithdraw}
                  >
                    {t('inspiration.withdraw')}
                  </Button>
                ) : null}
                {asset ? (
                  <RestrictionControl
                    kind="asset"
                    state={asset.restrictionState}
                    canRestrict={asset.capabilities.canRestrict}
                    canRelease={asset.capabilities.canRelease}
                    running={running}
                    onRestrict={() => onRestriction('asset', 'restrict')}
                    onRelease={() => onRestriction('asset', 'release')}
                  />
                ) : null}
                {publication ? (
                  <RestrictionControl
                    kind="publication"
                    state={publication.restrictionState}
                    canRestrict={publication.capabilities.canRestrict}
                    canRelease={publication.capabilities.canRelease}
                    running={running}
                    onRestrict={() => onRestriction('publication', 'restrict')}
                    onRelease={() => onRestriction('publication', 'release')}
                  />
                ) : null}
                {actionMessage ? (
                  <p
                    className={
                      actionStatus === 'failed'
                        ? 'text-destructive basis-full text-xs'
                        : 'text-muted-foreground basis-full text-xs'
                    }
                    role={actionStatus === 'failed' ? 'alert' : 'status'}
                  >
                    {actionMessage}
                  </p>
                ) : null}
              </DialogFooter>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function InspirationPage({
  ports,
  onCreateSimilar
}: InspirationPageProps): React.JSX.Element {
  const { t } = useTranslation('creation')
  const list = useInspiration(ports, initialFilters)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [selected, setSelected] = useState<InspirationItem | null>(null)
  const selectedRef = useRef<InspirationItem | null>(null)
  const [detail, setDetail] = useState<InspirationDetailView | null>(null)
  const [detailStatus, setDetailStatus] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [actionStatus, setActionStatus] = useState<'idle' | 'running' | 'succeeded' | 'failed'>(
    'idle'
  )
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!selected) return
    let active = true
    void ports.getInspirationDetail(selected).then((result) => {
      if (!active) return
      if (result.outcome !== 'succeeded') {
        setDetailStatus('failed')
        return
      }
      setDetail(result.value)
      setDetailStatus('idle')
    })
    return () => {
      active = false
    }
  }, [ports, selected])

  const close = (): void => {
    selectedRef.current = null
    setSelected(null)
    setDetail(null)
    setDetailStatus('idle')
    setActionStatus('idle')
    setActionMessage(null)
  }
  const open = (item: InspirationItem): void => {
    selectedRef.current = item
    setDetail(null)
    setDetailStatus('loading')
    setActionStatus('idle')
    setActionMessage(null)
    setSelected(item)
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="inspiration-page">
      <header className="px-page pt-6 pb-3">
        {/* The surface is its own title; the heading carries the a11y landmark. */}
        <h1 className="sr-only">{t('inspiration.title')}</h1>
        <div role="group" aria-label={t('inspiration.filters.media')} className="flex gap-1">
          {mediaTypes.map((mediaType) => {
            const active = list.submittedFilters.mediaType === mediaType
            return (
              <Button
                key={mediaType}
                type="button"
                size="sm"
                variant={active ? 'secondary' : 'ghost'}
                aria-pressed={active}
                className={active ? '' : 'text-muted-foreground font-normal'}
                onClick={() => {
                  scrollRef.current?.scrollTo({ top: 0 })
                  list.submit({ mediaType })
                }}
              >
                {t(`assets.media.${mediaType}`)}
              </Button>
            )
          })}
        </div>
      </header>
      <div ref={scrollRef} className="px-page min-h-0 flex-1 overflow-auto py-0.5">
        {list.status === 'loading' ? (
          <p className="text-muted-foreground p-5" role="status">
            {t('inspiration.loading')}
          </p>
        ) : list.status === 'failed' ? (
          <div className="space-y-2 p-5" role="alert">
            <p>{t('inspiration.loadFailed')}</p>
            <Button variant="outline" onClick={list.retry}>
              {t('state.retry')}
            </Button>
          </div>
        ) : (
          <>
            {list.items.length === 0 ? (
              <div className="space-y-2 p-5" role="status">
                <p>{t('inspiration.noResults')}</p>
              </div>
            ) : (
              <InspirationWall
                items={list.items}
                ports={ports}
                onOpen={open}
                onUnavailable={list.refresh}
              />
            )}
            {list.hasMore ? (
              <LoadMoreSentinel
                more={list.more}
                label={t('inspiration.pagination')}
                onLoadMore={list.loadMore}
                root={scrollRef}
                className="p-4"
              />
            ) : null}
          </>
        )}
      </div>
      <InspirationDetail
        item={selected}
        detail={detail}
        status={detailStatus}
        ports={ports}
        actionStatus={actionStatus}
        actionMessage={actionMessage}
        onClose={close}
        onDownload={() => {
          if (!selected) return
          void ports
            .loadInspirationContent(selected, {
              expectedByteSize: itemMedia(selected).byteSize
            })
            .then((result) => {
              if (result.outcome === 'succeeded') saveBlob(selected, result.value)
            })
        }}
        onCreateSimilar={() => {
          if (!selected) return
          const publication = publicationFor(selected, detail)
          if (!publication) return
          setActionStatus('running')
          setActionMessage(null)
          void onCreateSimilar(publication.id).then((outcome) => {
            if (outcome === 'prepared') return
            setActionStatus('failed')
            setActionMessage(t('inspiration.actionFailed'))
          })
        }}
        onWithdraw={() => {
          if (!selected) return
          const publication = publicationFor(selected, detail)
          if (!publication || !window.confirm(t('inspiration.withdrawConfirm'))) return
          setActionStatus('running')
          setActionMessage(null)
          void ports.withdrawPublication(publication.id).then((result) => {
            if (result.outcome !== 'succeeded') {
              setActionStatus('failed')
              setActionMessage(t('inspiration.actionFailed'))
              return
            }
            close()
            list.refresh()
          })
        }}
        onUnavailable={list.refresh}
        onRestriction={(target, operation) => {
          if (!selected || !detail) return
          const actionItem = selected
          const targetId =
            target === 'asset'
              ? detail.type === 'asset'
                ? detail.asset.id
                : null
              : publicationFor(selected, detail)?.id
          if (!targetId) return
          if (!window.confirm(t(`inspiration.restriction.${target}.${operation}Confirm`))) return
          setActionStatus('running')
          setActionMessage(t('inspiration.restriction.updating'))
          const pending =
            target === 'asset'
              ? operation === 'restrict'
                ? ports.restrictAsset(targetId)
                : ports.releaseAsset(targetId)
              : operation === 'restrict'
                ? ports.restrictPublication(targetId)
                : ports.releasePublication(targetId)
          void pending.then(async (result) => {
            if (result.outcome !== 'succeeded') {
              if (!sameItem(selectedRef.current, actionItem)) return
              setActionStatus('failed')
              setActionMessage(t('inspiration.restriction.failed'))
              return
            }
            list.refresh()
            if (!sameItem(selectedRef.current, actionItem)) return
            if (
              target === 'publication' &&
              operation === 'release' &&
              actionItem.type === 'publication'
            ) {
              close()
              return
            }
            setDetail((current) => {
              if (!current) return current
              if (target === 'asset') {
                return current.type === 'asset' ? { ...current, asset: result.value } : current
              }
              return { ...current, publication: result.value }
            })
            setActionStatus('succeeded')
            setActionMessage(t(`inspiration.restriction.${target}.${operation}Succeeded`))
            const refreshed = await ports.getInspirationDetail(actionItem)
            if (refreshed.outcome === 'succeeded' && sameItem(selectedRef.current, actionItem)) {
              setDetail(refreshed.value)
            }
          })
        }}
      />
    </section>
  )
}
