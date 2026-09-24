import { useTranslation } from 'react-i18next'
import { DownloadIcon, Trash2Icon, WandSparklesIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../components/ui/dialog'
import {
  alignAssetReferences,
  type AssetDetailView,
  type AssetLibraryPorts,
  type MediaAssetView
} from '../api/asset-library-http'
import { modeLabelKey } from '../i18n/mode-keys'
import type { AssetDetailStatus, AssetDownloadStatus } from '../model/use-asset-detail'
import { AssetMedia } from './asset-media'

export function AssetDetailDialog({
  assetId,
  detail,
  status,
  downloadStatus,
  reuseFailed,
  publicationStatus,
  ports,
  onClose,
  onOpenSibling,
  onDownload,
  onCreateSimilar,
  onPublish,
  onWithdraw,
  onDelete,
  onAssetUnavailable
}: {
  readonly assetId: string | null
  readonly detail: AssetDetailView | null
  readonly status: AssetDetailStatus
  readonly downloadStatus: AssetDownloadStatus
  readonly reuseFailed: boolean
  readonly publicationStatus: 'idle' | 'running' | 'failed' | 'reference-unavailable'
  readonly ports: AssetLibraryPorts
  readonly onClose: () => void
  readonly onOpenSibling: (assetId: string) => void
  readonly onDownload: (asset: MediaAssetView) => void
  readonly onCreateSimilar: () => void
  readonly onPublish: () => void
  readonly onWithdraw: () => void
  readonly onDelete: () => void
  /** The opened media answered gone or forbidden: the wall's facts are stale. */
  readonly onAssetUnavailable: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const alignedReferences = detail?.privateOrigin
    ? alignAssetReferences(detail.privateOrigin.specification, detail.privateOrigin.references)
    : []
  const hasUnavailableReferences = alignedReferences.some((reference) => reference === null)
  return (
    <Dialog open={assetId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="h-[calc(100svh-2rem)] max-h-[52rem] overflow-hidden p-0 sm:max-w-[min(76rem,calc(100%-2rem))]">
        <DialogHeader className="sr-only">
          <DialogTitle>{t('assets.detailTitle', { id: assetId })}</DialogTitle>
          <DialogDescription>{t('assets.detailDescription')}</DialogDescription>
        </DialogHeader>
        {status === 'loading' ? (
          <p className="p-8" role="status">
            {t('assets.loadingDetail')}
          </p>
        ) : status === 'failed' || detail === null ? (
          <p className="p-8" role="alert">
            {t('assets.detailFailed')}
          </p>
        ) : (
          <div className="grid size-full min-h-0 min-[800px]:grid-cols-[minmax(0,1fr)_22.5rem]">
            <div className="bg-muted grid min-h-56 min-w-0 place-items-center overflow-hidden p-4">
              <AssetMedia
                asset={detail.asset}
                ports={ports}
                detail
                onUnavailable={onAssetUnavailable}
              />
            </div>
            <div className="flex min-h-0 min-w-0 flex-col border-t min-[800px]:border-t-0 min-[800px]:border-l">
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
                <div>
                  <h2 className="truncate font-semibold">
                    {t('assets.detailTitle', { id: detail.asset.id })}
                  </h2>
                  <p className="text-muted-foreground text-xs">
                    {detail.asset.creator.displayName}
                  </p>
                </div>
                {detail.siblings.length > 1 ? (
                  <div>
                    <h3 className="mb-2 text-xs font-medium">{t('assets.siblings')}</h3>
                    <div className="flex flex-wrap gap-2">
                      {detail.siblings.map((sibling, index) => (
                        <Button
                          key={sibling.id}
                          type="button"
                          size="sm"
                          variant={sibling.id === detail.asset.id ? 'secondary' : 'outline'}
                          onClick={() => onOpenSibling(sibling.id)}
                        >
                          {t('assets.result', { n: index + 1 })}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">{t('assets.details.type')}</dt>
                  <dd>{t(`assets.media.${detail.asset.mediaType}`)}</dd>
                  <dt className="text-muted-foreground">{t('assets.details.size')}</dt>
                  <dd>{Math.ceil(detail.asset.byteSize / 1024)} KB</dd>
                  {detail.asset.widthPx && detail.asset.heightPx ? (
                    <>
                      <dt className="text-muted-foreground">{t('assets.details.dimensions')}</dt>
                      <dd>{`${detail.asset.widthPx} × ${detail.asset.heightPx}`}</dd>
                    </>
                  ) : null}
                  {detail.asset.durationMs !== null ? (
                    <>
                      <dt className="text-muted-foreground">
                        {t('assets.details.outputDuration')}
                      </dt>
                      <dd>{t('assets.details.seconds', { n: detail.asset.durationMs / 1000 })}</dd>
                    </>
                  ) : null}
                </dl>
                {detail.privateOrigin ? (
                  <div className="space-y-2 border-t pt-4 text-xs">
                    <h3 className="font-medium">{t('assets.origin.title')}</h3>
                    <p className="text-muted-foreground">
                      {detail.privateOrigin.sessionName || t('assets.origin.session')}
                    </p>
                    <p className="whitespace-pre-wrap">
                      {detail.privateOrigin.specification.prompt}
                    </p>
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                      <dt className="text-muted-foreground">{t('inspiration.schemaVersion')}</dt>
                      <dd>{detail.privateOrigin.specification.schemaVersion}</dd>
                      <dt className="text-muted-foreground">{t('assets.details.type')}</dt>
                      <dd>{t(`assets.media.${detail.privateOrigin.specification.mediaType}`)}</dd>
                      <dt className="text-muted-foreground">{t('gallery.details.mode')}</dt>
                      <dd>{t(modeLabelKey(detail.privateOrigin.specification.mode))}</dd>
                      <dt className="text-muted-foreground">{t('composer.model.label')}</dt>
                      <dd className="truncate">{detail.privateOrigin.specification.model}</dd>
                      <dt className="text-muted-foreground">{t('inspiration.manifestVersion')}</dt>
                      <dd>{detail.privateOrigin.specification.manifestVersion}</dd>
                      <dt className="text-muted-foreground">{t('composer.params.ratio')}</dt>
                      <dd>{detail.privateOrigin.specification.ratio || '—'}</dd>
                      <dt className="text-muted-foreground">{t('composer.params.resolution')}</dt>
                      <dd>{detail.privateOrigin.specification.resolution || '—'}</dd>
                      <dt className="text-muted-foreground">{t('gallery.details.quantity')}</dt>
                      <dd>{detail.privateOrigin.specification.quantity}</dd>
                      <dt className="text-muted-foreground">{t('gallery.details.duration')}</dt>
                      <dd>
                        {detail.privateOrigin.specification.durationSeconds === null
                          ? '—'
                          : t('assets.details.seconds', {
                              n: detail.privateOrigin.specification.durationSeconds
                            })}
                      </dd>
                    </dl>
                    <div className="space-y-2 border-t pt-3">
                      <h4 className="font-medium">
                        {t('inspiration.references')} (
                        {detail.privateOrigin.specification.references.length})
                      </h4>
                      {detail.privateOrigin.specification.references.length === 0 ? (
                        <p className="text-muted-foreground">{t('inspiration.noReferences')}</p>
                      ) : (
                        <ol className="space-y-1">
                          {detail.privateOrigin.specification.references.map((frozen, index) => {
                            const reference = alignedReferences[index]
                            return (
                              <li key={`${index}:${frozen.materialId}`} className="truncate">
                                {index + 1}.{' '}
                                {reference?.fileName ?? t('inspiration.unavailableReference')} ·{' '}
                                {t(
                                  `gallery.role.${frozen.role === 'first_frame' ? 'firstFrame' : frozen.role === 'last_frame' ? 'lastFrame' : frozen.role}`
                                )}{' '}
                                · {t(`composer.mention.kind.${frozen.kind}`)}
                                {reference ? (
                                  <>
                                    {' '}
                                    ·{' '}
                                    {t('inspiration.claimsVersion', {
                                      version: frozen.claimsVersion
                                    })}
                                  </>
                                ) : null}
                              </li>
                            )
                          })}
                        </ol>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
              <DialogFooter className="flex-row flex-wrap justify-start border-t p-4 sm:justify-start">
                <Button
                  type="button"
                  variant="outline"
                  disabled={downloadStatus === 'running'}
                  onClick={() => onDownload(detail.asset)}
                >
                  <DownloadIcon aria-hidden />
                  {t('assets.download')}
                </Button>
                <Button
                  type="button"
                  disabled={
                    !detail.asset.capabilities.canCreateSimilar || detail.privateOrigin === null
                  }
                  onClick={onCreateSimilar}
                >
                  <WandSparklesIcon aria-hidden />
                  {t('assets.createSimilar')}
                </Button>
                {detail.asset.publication ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={publicationStatus === 'running'}
                    onClick={onWithdraw}
                  >
                    {t('assets.withdraw')}
                  </Button>
                ) : detail.asset.capabilities.canPublish ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={publicationStatus === 'running' || hasUnavailableReferences}
                    onClick={onPublish}
                  >
                    {t(publicationStatus === 'running' ? 'assets.publishing' : 'assets.publish')}
                  </Button>
                ) : null}
                {detail.asset.capabilities.canDelete ? (
                  <Button type="button" variant="destructive" onClick={onDelete}>
                    <Trash2Icon aria-hidden />
                    {t('assets.delete')}
                  </Button>
                ) : null}
                {downloadStatus !== 'idle' ? (
                  <p
                    className="text-muted-foreground basis-full text-xs"
                    role="status"
                    aria-live="polite"
                  >
                    {t(`assets.downloadStatus.${downloadStatus}`)}
                  </p>
                ) : null}
                {reuseFailed ? (
                  <p className="text-destructive basis-full text-xs" role="alert">
                    {t('assets.createSimilarUnavailable')}
                  </p>
                ) : null}
                {publicationStatus === 'failed' ? (
                  <p className="text-destructive basis-full text-xs" role="alert">
                    {t('assets.publishFailed')}
                  </p>
                ) : null}
                {detail.asset.capabilities.canPublish && hasUnavailableReferences ? (
                  <p className="text-destructive basis-full text-xs" role="alert">
                    {t('assets.publishUnavailableReferences')}
                  </p>
                ) : publicationStatus === 'reference-unavailable' ? (
                  <p className="text-destructive basis-full text-xs" role="alert">
                    {t('assets.publishReferenceUnavailable')}
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
