import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DownloadIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  Undo2Icon,
  WandSparklesIcon
} from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { AssetDetailPreview, AssetPreviewAction } from './asset-detail-preview'
import type {
  InspirationDetailView,
  InspirationItem,
  InspirationPorts,
  PublicationView
} from '../api/inspiration-http'
import {
  alignAssetReferences,
  type AssetDetailView,
  type AssetLibraryPorts,
  type AssetPrivateOrigin,
  type MediaAssetView,
  type RestrictionState
} from '../api/asset-library-http'
import type { CreationWorkspacePorts } from '../model/ports'
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
  readonly ownAssetPorts?: AssetLibraryPorts & Pick<CreationWorkspacePorts, 'loadPreviewUrl'>
  readonly currentUserId?: string
  readonly onOpenSource?: (origin: AssetPrivateOrigin) => void
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
      className="col-span-full grid grid-cols-3 gap-2 border-t pt-3 text-xs"
    >
      <div className="col-span-full flex items-center justify-between gap-3">
        <h3 className="font-medium">{t(`inspiration.restriction.${kind}.label`)}</h3>
        <span className="text-muted-foreground">
          {t(`inspiration.restriction.state.${state ?? 'none'}`)}
        </span>
      </div>
      {canRestrict ? (
        <AssetPreviewAction
          icon={<ShieldOffIcon />}
          destructive
          disabled={running}
          onClick={onRestrict}
        >
          {t(`inspiration.restriction.${kind}.restrict`)}
        </AssetPreviewAction>
      ) : null}
      {canRelease ? (
        <AssetPreviewAction icon={<ShieldCheckIcon />} disabled={running} onClick={onRelease}>
          {t(`inspiration.restriction.${kind}.release`)}
        </AssetPreviewAction>
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

function InspirationDetail({
  ownAssetPorts,
  currentUserId,
  onOpenSource,
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
  readonly ownAssetPorts: InspirationPageProps['ownAssetPorts']
  readonly currentUserId: InspirationPageProps['currentUserId']
  readonly onOpenSource: InspirationPageProps['onOpenSource']
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
  const [ownSelectedId, setOwnSelectedId] = useState<string | null>(null)
  const [ownRead, setOwnRead] = useState<{ id: string; detail: AssetDetailView | null } | null>(
    null
  )
  const [ownDownloadStatus, setOwnDownloadStatus] = useState<'idle' | 'running' | 'failed'>('idle')
  const ownDownloadEpoch = useRef(0)
  const sourceId = item?.type === 'publication' ? item.publication.sourceAssetId : item?.asset.id
  const requestedOwnId = ownSelectedId ?? sourceId
  const ownDetail = ownRead && ownRead.id === requestedOwnId ? ownRead.detail : null
  useEffect(() => {
    const creatorId =
      item?.type === 'publication' ? item.publication.publisher.id : item?.asset.creator.id
    if (!requestedOwnId || !ownAssetPorts || !currentUserId || creatorId !== currentUserId) return
    let active = true
    void ownAssetPorts
      .getAsset(requestedOwnId)
      .then((result) => {
        if (!active) return
        setOwnRead({
          id: requestedOwnId,
          detail:
            result.outcome === 'succeeded' &&
            result.value.asset.id === requestedOwnId &&
            result.value.asset.creator.id === currentUserId &&
            result.value.privateOrigin !== null
              ? result.value
              : null
        })
      })
      .catch(() => {
        if (active) setOwnRead({ id: requestedOwnId, detail: null })
      })
    return () => {
      active = false
    }
  }, [currentUserId, item, ownAssetPorts, requestedOwnId])
  const ownAsset = ownSelectedId ? ownDetail?.asset : null
  const media = ownSelectedId ? (ownAsset ?? null) : item ? itemMedia(item) : null
  const contentPort = useMemo(
    () => (ownSelectedId ? (ownAssetPorts ?? null) : item ? mediaPort(ports, item) : null),
    [item, ownAssetPorts, ownSelectedId, ports]
  )
  const publication = item && !ownSelectedId ? publicationFor(item, detail) : null
  const asset: MediaAssetView | null =
    !ownSelectedId && detail?.type === 'asset' ? detail.asset : null
  const origin = ownDetail?.privateOrigin
  const specification = ownSelectedId ? origin?.specification : detail?.specification
  const references = useMemo(
    () =>
      specification
        ? alignAssetReferences(
            specification,
            ownSelectedId ? (origin?.references ?? []) : (detail?.references ?? [])
          )
        : [],
    [detail?.references, origin?.references, ownSelectedId, specification]
  )
  const loadReferencePreview = useCallback(
    async (referenceId: string) => {
      const result =
        ownSelectedId && ownAssetPorts
          ? await ownAssetPorts.loadPreviewUrl(referenceId)
          : item
            ? await ports.loadInspirationReferencePreview(item, referenceId)
            : null
      return result?.outcome === 'succeeded' ? result.value : null
    },
    [item, ownAssetPorts, ownSelectedId, ports]
  )
  const running = actionStatus === 'running'
  const ownStatus =
    ownRead && ownRead.id === requestedOwnId ? (ownRead.detail ? 'ready' : 'failed') : 'loading'
  const siblings =
    ownDetail?.siblings.filter((sibling) => sibling.creator.id === currentUserId) ?? []
  const actionMessageText = ownSelectedId
    ? ownDownloadStatus === 'failed'
      ? t('assets.downloadStatus.failed')
      : ownDownloadStatus === 'running'
        ? t('assets.downloadStatus.running')
        : null
    : actionMessage
  return (
    <AssetDetailPreview
      open={item !== null}
      title={t('inspiration.detailTitle')}
      description={t('inspiration.detailDescription')}
      onClose={onClose}
      status={
        ownSelectedId
          ? ownStatus
          : status === 'loading'
            ? 'loading'
            : status === 'failed' || !detail
              ? 'failed'
              : 'ready'
      }
      media={
        media && contentPort ? (
          <AssetMedia asset={media} ports={contentPort} detail onUnavailable={onUnavailable} />
        ) : null
      }
      specification={specification}
      references={references}
      loadReferencePreview={loadReferencePreview}
      origin={
        origin
          ? {
              taskId: origin.taskId,
              name: origin.sessionName ?? origin.taskId,
              onOpen: onOpenSource
                ? () => {
                    onClose()
                    onOpenSource(origin)
                  }
                : undefined
            }
          : null
      }
      results={
        ownAssetPorts
          ? siblings.map((sibling, index) => ({
              id: sibling.id,
              label: t('assets.result', { n: index + 1 }),
              media: <AssetMedia asset={sibling} ports={ownAssetPorts} />
            }))
          : []
      }
      selectedResultId={requestedOwnId}
      onSelectResult={(id) => {
        ownDownloadEpoch.current += 1
        setOwnSelectedId(id === sourceId ? null : id)
        setOwnDownloadStatus('idle')
      }}
      headerActions={
        item ? (
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">
              {ownAsset?.creator.displayName ?? itemCreator(item)}
            </p>
            <p className="text-muted-foreground mt-1 text-[10px]">
              {new Date(ownAsset?.createdAt ?? itemDate(item)).toLocaleString()}
            </p>
          </div>
        ) : null
      }
      metadata={
        media ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[10px]">
            <dt className="text-muted-foreground">{t('assets.details.type')}</dt>
            <dd>{t(`assets.media.${media.mediaType}`)}</dd>
            <dt className="text-muted-foreground">{t('assets.details.size')}</dt>
            <dd>{Math.ceil(media.byteSize / 1024)} KB</dd>
            <dt className="text-muted-foreground">{t('assets.details.dimensions')}</dt>
            <dd>
              {media.widthPx && media.heightPx ? `${media.widthPx} × ${media.heightPx}` : '—'}
            </dd>
          </dl>
        ) : null
      }
      actions={
        detail ? (
          <>
            <AssetPreviewAction
              icon={<DownloadIcon />}
              disabled={ownDownloadStatus === 'running' || (!!ownSelectedId && !ownAsset)}
              onClick={
                ownAsset && ownAssetPorts
                  ? () => {
                      const epoch = ++ownDownloadEpoch.current
                      setOwnDownloadStatus('running')
                      void ownAssetPorts
                        .downloadAssetContent(ownAsset.id, ownAsset.checksumSha256, {
                          expectedByteSize: ownAsset.byteSize
                        })
                        .then((result) => {
                          if (result.outcome !== 'succeeded') {
                            if (ownDownloadEpoch.current === epoch) setOwnDownloadStatus('failed')
                            return
                          }
                          saveBlob({ type: 'asset', asset: ownAsset }, result.value)
                          if (ownDownloadEpoch.current === epoch) setOwnDownloadStatus('idle')
                        })
                        .catch(() => {
                          if (ownDownloadEpoch.current === epoch) setOwnDownloadStatus('failed')
                        })
                    }
                  : onDownload
              }
            >
              {t('assets.download')}
            </AssetPreviewAction>
            {publication?.capabilities.canCreateSimilar ? (
              <AssetPreviewAction
                icon={<WandSparklesIcon />}
                disabled={running}
                onClick={onCreateSimilar}
              >
                {t('assets.createSimilar')}
              </AssetPreviewAction>
            ) : null}
            {publication?.capabilities.canWithdraw ? (
              <AssetPreviewAction
                icon={<Undo2Icon />}
                destructive
                disabled={running}
                onClick={onWithdraw}
              >
                {t('inspiration.withdraw')}
              </AssetPreviewAction>
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
          </>
        ) : null
      }
      messages={
        actionMessageText ? (
          <p
            className={
              actionStatus === 'failed'
                ? 'text-destructive text-xs'
                : 'text-muted-foreground text-xs'
            }
            role={
              ownSelectedId
                ? ownDownloadStatus === 'failed'
                  ? 'alert'
                  : 'status'
                : actionStatus === 'failed'
                  ? 'alert'
                  : 'status'
            }
          >
            {actionMessageText}
          </p>
        ) : null
      }
    />
  )
}

export function InspirationPage({
  ports,
  ownAssetPorts,
  currentUserId,
  onOpenSource,
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
        key={selected ? `${selected.type}:${itemId(selected)}` : 'closed'}
        ownAssetPorts={ownAssetPorts}
        currentUserId={currentUserId}
        onOpenSource={onOpenSource}
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
