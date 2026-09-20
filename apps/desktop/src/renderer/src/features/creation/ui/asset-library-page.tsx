import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DownloadIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import type { AssetLibraryPorts, MediaAssetView } from '../api/asset-library-http'
import type { InspirationPorts } from '../api/inspiration-http'
import { useAssetDetail, type PrepareAssetSimilar } from '../model/use-asset-detail'
import { isoDay, useAssetList, type AssetFilters } from '../model/use-asset-list'
import { useAssetSelectionDownloads } from '../model/use-asset-selection-downloads'
import { AssetDetailDialog } from './asset-detail-dialog'
import { AssetLibraryFilters } from './asset-library-filters'
import { AssetCard } from './asset-media'

export interface AssetLibraryPageProps {
  readonly ports: AssetLibraryPorts & Pick<InspirationPorts, 'publishAsset' | 'withdrawPublication'>
  readonly onCreateSimilar: PrepareAssetSimilar
}

const initialFilters: AssetFilters = {
  mediaType: 'image',
  createdSince: '',
  createdUntil: '',
  sort: 'newest',
  search: ''
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
  const selection = useAssetSelectionDownloads(ports, list.assets, saveBlob)
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

  const batchRunning = selection.status.kind === 'running'
  const batchProgress =
    selection.status.kind === 'idle'
      ? null
      : selection.status.kind === 'complete'
        ? t('assets.batch.complete', {
            done: selection.status.total,
            total: selection.status.total
          })
        : t(`assets.batch.${selection.status.kind}`, {
            done: selection.status.current,
            total: selection.status.total
          })

  const apply = (next: AssetFilters): void => {
    setFilters(next)
    selection.resetPage()
    list.submit(next)
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="asset-library">
      <div className="px-page flex flex-wrap items-center justify-between gap-3 pt-6 pb-3">
        <h1 className="sr-only">{t('assets.title')}</h1>
        <AssetLibraryFilters filters={filters} onChange={apply} />
        <Button
          type="button"
          variant={selection.selecting ? 'secondary' : 'outline'}
          onClick={() => (selection.selecting ? selection.exit() : selection.begin())}
        >
          {selection.selecting ? t('assets.selection.exit') : t('assets.selection.enter')}
        </Button>
      </div>

      {selection.selecting ? (
        <div
          data-testid="batch-toolbar"
          className="bg-muted/50 px-page flex flex-wrap items-center gap-2 border-b py-2"
        >
          <Button
            type="button"
            size="sm"
            disabled={selection.selection.size === 0 || batchRunning}
            onClick={() => void selection.download()}
          >
            <DownloadIcon aria-hidden />
            {t('assets.batch.download', { count: selection.selection.size })}
          </Button>
          {batchRunning ? (
            <Button type="button" size="sm" variant="outline" onClick={selection.cancel}>
              {t('assets.batch.cancel')}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={selection.exit}>
              {t('assets.selection.exit')}
            </Button>
          )}
          {batchProgress ? (
            <p className="text-muted-foreground ml-auto text-sm" role="status" aria-live="polite">
              {batchProgress}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="px-page min-h-0 flex-1 overflow-auto py-5">
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
        ) : list.assets.length === 0 ? (
          <p className="text-muted-foreground" role="status">
            {t('assets.empty')}
          </p>
        ) : (
          <div className="space-y-7">
            {groups.map(([date, group]) => (
              <section key={date} data-testid="asset-group" aria-labelledby={`assets-${date}`}>
                <h2 id={`assets-${date}`} className="mb-3 text-sm font-semibold">
                  {new Intl.DateTimeFormat(i18n.language, { month: 'long', day: 'numeric' }).format(
                    new Date(`${date}T00:00:00`)
                  )}
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
            ))}
            <nav
              className="flex items-center justify-end gap-2"
              aria-label={t('assets.pagination')}
            >
              <Button
                type="button"
                variant="outline"
                disabled={!list.canPrevious}
                onClick={() => {
                  selection.resetPage()
                  list.previous()
                }}
              >
                {t('assets.previous')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!list.canNext}
                onClick={() => {
                  selection.resetPage()
                  list.next()
                }}
              >
                {t('assets.next')}
              </Button>
            </nav>
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
