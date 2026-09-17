import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DownloadIcon, SearchIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import type { AssetLibraryPorts, AssetSort, MediaAssetView } from '../api/asset-library-http'
import type { InspirationPorts } from '../api/inspiration-http'
import { useAssetDetail, type PrepareAssetSimilar } from '../model/use-asset-detail'
import { useAssetList, type AssetFilters } from '../model/use-asset-list'
import { useAssetSelectionDownloads } from '../model/use-asset-selection-downloads'
import { AssetDetailDialog } from './asset-detail-dialog'
import { AssetCard } from './asset-media'

export interface AssetLibraryPageProps {
  readonly ports: AssetLibraryPorts & Pick<InspirationPorts, 'publishAsset' | 'withdrawPublication'>
  readonly onCreateSimilar: PrepareAssetSimilar
}

const initialFilters: AssetFilters = {
  mediaType: '',
  createdSince: '',
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
  if (Number.isNaN(date.getTime())) return value
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
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

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="asset-library">
      <div className="border-b px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t('assets.title')}</h1>
            <p className="text-muted-foreground text-sm">{t('assets.description')}</p>
          </div>
          <Button
            type="button"
            variant={selection.selecting ? 'secondary' : 'outline'}
            onClick={() => (selection.selecting ? selection.exit() : selection.begin())}
          >
            {selection.selecting ? t('assets.selection.exit') : t('assets.selection.enter')}
          </Button>
        </div>
        <form
          data-testid="asset-filters"
          className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-[6.5rem_9rem_7rem_minmax(9rem,1.5fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault()
            selection.resetPage()
            list.submit(filters)
          }}
        >
          <label className="grid gap-1 text-xs">
            <span className="sr-only">{t('assets.filters.media')}</span>
            <select
              aria-label={t('assets.filters.media')}
              value={filters.mediaType}
              onChange={(event) => {
                const mediaType = event.currentTarget.value as AssetFilters['mediaType']
                setFilters((value) => ({
                  ...value,
                  mediaType
                }))
              }}
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
            >
              <option value="">{t('assets.filters.all')}</option>
              <option value="image">{t('assets.media.image')}</option>
              <option value="video">{t('assets.media.video')}</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            <span className="sr-only">{t('assets.filters.since')}</span>
            <Input
              type="date"
              aria-label={t('assets.filters.since')}
              value={filters.createdSince}
              onChange={(event) => {
                const createdSince = event.currentTarget.value
                setFilters((value) => ({ ...value, createdSince }))
              }}
            />
          </label>
          <label className="grid gap-1 text-xs">
            <span className="sr-only">{t('assets.filters.sort')}</span>
            <select
              aria-label={t('assets.filters.sort')}
              value={filters.sort}
              onChange={(event) => {
                const sort = event.currentTarget.value as AssetSort
                setFilters((value) => ({
                  ...value,
                  sort
                }))
              }}
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
            >
              <option value="newest">{t('assets.filters.newest')}</option>
              <option value="oldest">{t('assets.filters.oldest')}</option>
            </select>
          </label>
          <label className="col-span-2 grid gap-1 text-xs sm:col-span-1">
            <span className="sr-only">{t('assets.filters.search')}</span>
            <Input
              aria-label={t('assets.filters.search')}
              placeholder={t('assets.filters.searchHint')}
              value={filters.search}
              onChange={(event) => {
                const search = event.currentTarget.value
                setFilters((value) => ({ ...value, search }))
              }}
            />
          </label>
          <Button type="submit" className="self-end">
            <SearchIcon aria-hidden />
            {t('assets.filters.submit')}
          </Button>
        </form>
      </div>

      {selection.selecting ? (
        <div
          data-testid="batch-toolbar"
          className="bg-muted/50 flex flex-wrap items-center gap-2 border-b px-4 py-2 sm:px-6"
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

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4 sm:px-6">
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
          <div className="space-y-4">
            {groups.map(([date, group]) => (
              <section key={date} data-testid="asset-group" aria-labelledby={`assets-${date}`}>
                <h2 id={`assets-${date}`} className="mb-2 text-sm font-semibold">
                  {new Intl.DateTimeFormat(i18n.language, { dateStyle: 'long' }).format(
                    new Date(`${date}T00:00:00`)
                  )}
                </h2>
                <ul className="grid grid-cols-2 gap-x-2 gap-y-3 sm:grid-cols-5 xl:grid-cols-8">
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
