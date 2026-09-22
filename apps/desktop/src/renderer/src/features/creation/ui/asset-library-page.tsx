import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DownloadIcon, ListChecksIcon, Trash2Icon, UploadIcon, XIcon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
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

interface ActionFit {
  readonly label: string
  readonly icon: string
}

/**
 * What the three actions need of the toolbar's own box to sit on the filters'
 * row beside the exit control, measured from the rendered row: 289px in English.
 * Below it the labels hide for the icons — the label keeps the accessible name,
 * which is what `sr-only` buys over `display: none` — and a labelled toolbar is
 * therefore the row it has always been, in every locale. A longer label moves
 * this number, which the geometry tests in asset-library.spec.tsx pin.
 */
const WIDE_ACTION_FIT: ActionFit = {
  label: '@max-[289px]:sr-only',
  icon: 'hidden @max-[289px]:block'
}

/**
 * Chinese's labels are shorter: 214px, where English's need 289. Load-bearing
 * even though no window this app allows reaches its threshold — without it
 * Chinese would fall back to English's and lose its labels at the minimum
 * window, where they fit.
 */
const SHORT_ACTION_FIT: ActionFit = {
  label: '@max-[214px]:sr-only',
  icon: 'hidden @max-[214px]:block'
}

/**
 * A locale that is not listed yet takes English's threshold, the wider of the
 * two measured: hiding a label a little early costs an icon-only toolbar, hiding
 * it too late costs a covered filter, and only the second is a defect. It is
 * only right for a locale whose labels are no wider than English's, so a longer
 * one has to be measured as it is added.
 */
function actionFit(language: string): ActionFit {
  return language === 'zh-CN' ? SHORT_ACTION_FIT : WIDE_ACTION_FIT
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
  const selectionStatus = batchProgress ?? t('assets.selection.count', { count: selectionSize })
  // One control either way: leaving the mode, or ending the run that holds it.
  const modeExit =
    running === null ? t('assets.selection.exit') : t('assets.batch.cancel', { action })
  const fit = actionFit(i18n.language)

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
          // Sits on the filters' row at every width the window allows (a zero
          // basis never wraps): the filters keep their size, the actions keep
          // theirs, and the status is what gives — a second row here would push
          // the wall down the moment the mode is entered. This box is also the
          // container the actions' labels measure themselves against.
          <div
            data-testid="batch-toolbar"
            className="@container flex min-w-0 flex-1 items-center justify-end gap-2"
          >
            <p
              className="text-muted-foreground min-w-0 truncate text-sm"
              role="status"
              aria-live="polite"
              title={selectionStatus}
            >
              {selectionStatus}
            </p>
            <div className="border-border flex items-center rounded-lg border p-0.5">
              <BatchAction
                fit={fit}
                Icon={Trash2Icon}
                label={t('assets.batch.remove')}
                disabled={selectionSize === 0 || running !== null}
                onClick={() => {
                  if (window.confirm(t('assets.batch.removeConfirm', { count: selectionSize })))
                    void selection.remove()
                }}
              />
              <span className="bg-border mx-0.5 h-4 w-px" aria-hidden />
              <BatchAction
                fit={fit}
                Icon={DownloadIcon}
                label={t('assets.batch.download')}
                disabled={selectionSize === 0 || running !== null}
                onClick={() => void selection.download()}
              />
              <span className="bg-border mx-0.5 h-4 w-px" aria-hidden />
              <BatchAction
                fit={fit}
                Icon={UploadIcon}
                label={t('assets.batch.publish')}
                disabled={!selection.publishable || running !== null}
                onClick={() => {
                  if (window.confirm(t('assets.batch.publishConfirm', { count: selectionSize })))
                    void selection.publish()
                }}
              />
            </div>
            {/* Icon-only to leave room for the status on one row, and the
                mirror of the icon-only control that enters the mode. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={modeExit}
                  onClick={running === null ? selection.exit : selection.cancel}
                >
                  <XIcon aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{modeExit}</TooltipContent>
            </Tooltip>
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

/**
 * The tooltip names the action in both of its widths, which is the only name the
 * icon-only one has. Two things keep it there: the label is hidden, not
 * removed, so it stays the accessible name; and the trigger is a wrapper rather
 * than the button, because a disabled `Button` is `pointer-events-none` and
 * could not see the hover — and batch mode opens with all three disabled.
 */
function BatchAction({
  fit,
  Icon,
  label,
  disabled,
  onClick
}: {
  readonly fit: ActionFit
  readonly Icon: LucideIcon
  readonly label: string
  readonly disabled: boolean
  readonly onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onClick}>
            <Icon aria-hidden className={fit.icon} />
            <span className={fit.label}>{label}</span>
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
