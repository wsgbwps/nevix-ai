import { useTranslation } from 'react-i18next'
import { DownloadIcon, Trash2Icon, UploadIcon, WandSparklesIcon } from 'lucide-react'
import {
  alignAssetReferences,
  type AssetDetailView,
  type AssetLibraryPorts,
  type AssetPrivateOrigin,
  type MediaAssetView
} from '../api/asset-library-http'
import type { AssetDetailStatus, AssetDownloadStatus } from '../model/use-asset-detail'
import { AssetDetailPreview, AssetPreviewAction } from './asset-detail-preview'
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
  onAssetUnavailable,
  onOpenOrigin,
  loadReferencePreview
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
  readonly onAssetUnavailable: () => void
  readonly onOpenOrigin?: (origin: AssetPrivateOrigin) => void
  readonly loadReferencePreview?: (
    materialId: string
  ) => Promise<{ readonly url: string; readonly release?: () => void } | null>
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const origin = detail?.privateOrigin
  const alignedReferences = origin
    ? alignAssetReferences(origin.specification, origin.references)
    : []
  const hasUnavailableReferences = alignedReferences.some((reference) => reference === null)
  const hasActions =
    detail &&
    (detail.asset.publication ||
      detail.asset.capabilities.canDelete ||
      (origin &&
        (detail.asset.capabilities.canCreateSimilar || detail.asset.capabilities.canPublish)))
  const hasMessages =
    downloadStatus !== 'idle' ||
    reuseFailed ||
    publicationStatus === 'failed' ||
    publicationStatus === 'reference-unavailable' ||
    (detail?.asset.capabilities.canPublish && hasUnavailableReferences)

  return (
    <AssetDetailPreview
      open={assetId !== null}
      title={t('assets.detailTitle', { id: assetId })}
      description={t('assets.detailDescription')}
      onClose={onClose}
      status={
        status === 'loading'
          ? 'loading'
          : status === 'failed' || detail === null
            ? 'failed'
            : 'ready'
      }
      media={
        detail ? (
          <AssetMedia
            asset={detail.asset}
            ports={ports}
            detail
            onUnavailable={onAssetUnavailable}
          />
        ) : null
      }
      origin={
        origin
          ? {
              taskId: origin.taskId,
              name: origin.sessionName || t('assets.origin.session'),
              onOpen: onOpenOrigin ? () => onOpenOrigin(origin) : undefined
            }
          : null
      }
      results={
        origin && detail
          ? detail.siblings.map((sibling, index) => ({
              id: sibling.id,
              label: t('assets.result', { n: index + 1 }),
              media: <AssetMedia asset={sibling} ports={ports} onUnavailable={onAssetUnavailable} />
            }))
          : []
      }
      selectedResultId={detail?.asset.id}
      onSelectResult={onOpenSibling}
      specification={origin?.specification}
      references={alignedReferences}
      loadReferencePreview={loadReferencePreview}
      metadata={
        detail ? (
          <div>
            <p className="mb-2 truncate text-xs">{detail.asset.creator.displayName}</p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[10px]">
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
                  <dt className="text-muted-foreground">{t('assets.details.outputDuration')}</dt>
                  <dd>{t('assets.details.seconds', { n: detail.asset.durationMs / 1000 })}</dd>
                </>
              ) : null}
            </dl>
          </div>
        ) : null
      }
      headerActions={
        detail ? (
          <button
            type="button"
            className="focus-visible:ring-ring hover:text-primary flex items-center gap-2 rounded-md px-2 py-2 text-xs font-semibold outline-none focus-visible:ring-2 disabled:opacity-50"
            disabled={downloadStatus === 'running'}
            onClick={() => onDownload(detail.asset)}
          >
            <DownloadIcon className="size-4" aria-hidden />
            {t('assets.download')}
          </button>
        ) : null
      }
      actions={
        detail && hasActions ? (
          <>
            {detail.asset.capabilities.canCreateSimilar && origin ? (
              <AssetPreviewAction icon={<WandSparklesIcon aria-hidden />} onClick={onCreateSimilar}>
                {t('assets.createSimilar')}
              </AssetPreviewAction>
            ) : null}
            {detail.asset.publication ? (
              <AssetPreviewAction
                icon={<UploadIcon aria-hidden />}
                disabled={publicationStatus === 'running'}
                onClick={onWithdraw}
              >
                {t('assets.withdraw')}
              </AssetPreviewAction>
            ) : detail.asset.capabilities.canPublish && origin ? (
              <AssetPreviewAction
                icon={<UploadIcon aria-hidden />}
                disabled={publicationStatus === 'running' || hasUnavailableReferences}
                onClick={onPublish}
              >
                {t(publicationStatus === 'running' ? 'assets.publishing' : 'assets.publish')}
              </AssetPreviewAction>
            ) : null}
            {detail.asset.capabilities.canDelete ? (
              <AssetPreviewAction icon={<Trash2Icon aria-hidden />} destructive onClick={onDelete}>
                {t('assets.delete')}
              </AssetPreviewAction>
            ) : null}
          </>
        ) : null
      }
      messages={
        detail && hasMessages ? (
          <>
            {downloadStatus !== 'idle' ? (
              <p className="text-muted-foreground text-xs" role="status" aria-live="polite">
                {t(`assets.downloadStatus.${downloadStatus}`)}
              </p>
            ) : null}
            {reuseFailed ? (
              <p className="text-destructive text-xs" role="alert">
                {t('assets.createSimilarUnavailable')}
              </p>
            ) : null}
            {publicationStatus === 'failed' ? (
              <p className="text-destructive text-xs" role="alert">
                {t('assets.publishFailed')}
              </p>
            ) : null}
            {detail.asset.capabilities.canPublish && hasUnavailableReferences ? (
              <p className="text-destructive text-xs" role="alert">
                {t('assets.publishUnavailableReferences')}
              </p>
            ) : publicationStatus === 'reference-unavailable' ? (
              <p className="text-destructive text-xs" role="alert">
                {t('assets.publishReferenceUnavailable')}
              </p>
            ) : null}
          </>
        ) : null
      }
    />
  )
}
