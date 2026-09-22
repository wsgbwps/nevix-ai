import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListChecksIcon, XIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip'
import type { AssetLibraryPorts, MediaAssetView } from '../api/asset-library-http'
import type { InspirationPorts } from '../api/inspiration-http'
import { useAssetDetail, type PrepareAssetSimilar } from '../model/use-asset-detail'
import { isoDay, useAssetList, type AssetFilters } from '../model/use-asset-list'
import { useAssetSelectionActions } from '../model/use-asset-selection-actions'
import { AssetDetailDialog } from './asset-detail-dialog'
import { AssetLibraryFilters } from './asset-library-filters'
import { AssetCard } from './asset-media'
import { LoadMoreSentinel } from './load-more-sentinel'

export interface AssetLibraryPageProps {
  readonly ports: AssetLibraryPorts & Pick<InspirationPorts, 'publishAsset' | 'withdrawPublication'>
  readonly onCreateSimilar: PrepareAssetSimilar
}

const initialFilters: AssetFilters = {
  mediaType: 'image',
  createdSince: '',
  createdUntil: '',
  sort: 'newest',
  modes: [],
  ratios: [],
  resolutions: []
}

function saveBlob(asset: MediaAssetView, blob: Blob): void {
  const extension = asset.mimeType.split('/')[1]?.split(/[;+]/)[0] || 'bin'
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `asset-${asset.id}.${extension}`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function dayKey(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : isoDay(date)
}

export function AssetLibraryPage({
  ports,
  onCreateSimilar
}: AssetLibraryPageProps): React.JSX.Element {
  const { t, i18n } = useTranslation('creation')
  const [filters, setFilters] = useState(initialFilters)
  const list = useAssetList(ports, initialFilters)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const selection = useAssetSelectionActions(ports, list.assets, saveBlob, list.refresh)
  const detail = useAssetDetail({
    ports,
    prepareSimilar: onCreateSimilar,
    save: saveBlob,
    onAssetsChanged: list.refresh
  })

  const groups = useMemo(() => {
    const grouped = new Map<string, MediaAssetView[]>()
    for (const asset of list.assets) {
      const key = dayKey(asset.createdAt)
      const group = grouped.get(key)
      if (group) group.push(asset)
      else grouped.set(key, [asset])
    }
    return [...grouped]
  }, [list.assets])

  const status = selection.status
  const running = status.kind === 'running' ? status : null
  const action = status.kind === 'idle' ? null : t(`assets.batch.${status.action}`)
  const batchProgress =
    status.kind === 'idle' || action === null
      ? null
      : status.kind === 'complete'
        ? status.skipped === undefined
          ? t('assets.batch.complete', { action, done: status.total, total: status.total })
          : t('assets.batch.publishComplete', {
              done: status.total - status.skipped,
              total: status.total,
              skipped: status.skipped
            })
        : t(`assets.batch.${status.kind}`, {
            action,
            done: status.current,
            total: status.total
          })
  const selectionSize = selection.selection.size

  const apply = (next: AssetFilters): void => {
    setFilters(next)
    selection.resetPage()
    // A narrower result would leave the sentinel in reach and append unasked.
    scrollRef.current?.scrollTo({ top: 0 })
    list.submit(next)
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="asset-library">
      <div className="px-page flex flex-wrap items-center justify-between gap-3 pt-6 pb-3">
        <h1 className="sr-only">{t('assets.title')}</h1>
        <AssetLibraryFilters filters={filters} facets={list.facets} onChange={apply} />
        {selection.selecting ? (
          <div data-testid="batch-toolbar" className="flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground text-sm" role="status" aria-live="polite">
              {batchProgress ?? t('assets.selection.count', { count: selectionSize })}
            </p>
            <div className="border-border flex items-center rounded-lg border p-0.5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={selectionSize === 0 || running !== null}
                onClick={() => {
                  if (window.confirm(t('assets.batch.removeConfirm', { count: selectionSize })))
                    void selection.remove()
                }}
              >
                {t('assets.batch.remove')}
              </Button>
              <span className="bg-border mx-0.5 h-4 w-px" aria-hidden />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={selectionSize === 0 || running !== null}
                onClick={() => void selection.download()}
              >
                {t('assets.batch.download')}
              </Button>
              <span className="bg-border mx-0.5 h-4 w-px" aria-hidden />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!selection.publishable || running !== null}
                onClick={() => {
                  if (window.confirm(t('assets.batch.publishConfirm', { count: selectionSize })))
                    void selection.publish()
                }}
              >
                {t('assets.batch.publish')}
              </Button>
            </div>
            {running === null ? (
              <Button type="button" size="sm" variant="ghost" onClick={selection.exit}>
                <XIcon aria-hidden />
                {t('assets.selection.exit')}
              </Button>
            ) : (
              <Button type="button" size="sm" variant="ghost" onClick={selection.cancel}>
                <XIcon aria-hidden />
                {t('assets.batch.cancel', { action })}
              </Button>
            )}
          </div>
        ) : (
          // Holds the batch toolbar's row — h-8 buttons in a 1px border and 2px
          // padding. The two drift apart silently: keep them equal.
          <div className="flex min-h-9.5 items-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('assets.selection.enter')}
                  onClick={selection.begin}
                >
                  <ListChecksIcon aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('assets.selection.enter')}</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      <div ref={scrollRef} className="px-page min-h-0 flex-1 overflow-auto py-5">
        {list.status === 'loading' ? (
          <p className="text-muted-foreground" role="status">
            {t('assets.loading')}
          </p>
        ) : list.status === 'failed' ? (
          <div role="alert" className="space-y-2">
            <p>{t('assets.loadFailed')}</p>
            <Button variant="outline" onClick={list.retry}>
              {t('state.retry')}
            </Button>
          </div>
        ) : (
          <div className="space-y-7">
            {list.assets.length === 0 ? (
              <p className="text-muted-foreground" role="status">
                {t('assets.empty')}
              </p>
            ) : (
              groups.map(([date, group]) => (
                <section key={date} data-testid="asset-group" aria-labelledby={`assets-${date}`}>
                  <h2 id={`assets-${date}`} className="mb-3 text-sm font-semibold">
                    {new Intl.DateTimeFormat(i18n.language, {
                      month: 'long',
                      day: 'numeric'
                    }).format(new Date(`${date}T00:00:00`))}
                  </h2>
                  <ul className="grid grid-cols-2 gap-x-2 gap-y-4 sm:grid-cols-5 xl:grid-cols-8">
                    {group.map((asset) => (
                      <AssetCard
                        key={asset.id}
                        asset={asset}
                        ports={ports}
                        selecting={selection.selecting}
                        selected={selection.selection.has(asset.id)}
                        onSelect={() => selection.toggle(asset.id)}
                        onOpen={() => detail.open(asset.id)}
                      />
                    ))}
                  </ul>
                </section>
              ))
            )}
            {list.hasMore ? (
              <LoadMoreSentinel
                more={list.more}
                label={t('assets.pagination')}
                onLoadMore={list.loadMore}
                root={scrollRef}
                className="pt-1"
              />
            ) : null}
          </div>
        )}
      </div>

      <AssetDetailDialog
        assetId={detail.assetId}
        detail={detail.detail}
        status={detail.status}
        downloadStatus={detail.downloadStatus}
        reuseFailed={detail.reuseFailed}
        publicationStatus={detail.publicationStatus}
        ports={ports}
        onClose={detail.close}
        onOpenSibling={detail.open}
        onDownload={(asset) => void detail.download(asset)}
        onCreateSimilar={() =>
          void detail.createSimilar(() => window.confirm(t('assets.replaceDraftConfirm')))
        }
        onPublish={() =>
          void detail.publish((count) => window.confirm(t('assets.publishConfirm', { count })))
        }
        onWithdraw={() => void detail.withdraw(() => window.confirm(t('assets.withdrawConfirm')))}
        onDelete={() => void detail.remove(() => window.confirm(t('assets.deleteConfirm')))}
      />
    </section>
  )
}
