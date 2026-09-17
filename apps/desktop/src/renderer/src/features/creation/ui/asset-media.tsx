import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageIcon, LoaderCircleIcon, VideoIcon } from 'lucide-react'
import type { AssetLibraryPorts, MediaAssetView } from '../api/asset-library-http'
import { useAssetContent, WALL_PREVIEW_MAX_BYTES, type AssetContentPort } from './use-asset-content'

export type MediaPreviewView = Pick<
  MediaAssetView,
  'id' | 'mediaType' | 'mimeType' | 'byteSize' | 'checksumSha256'
>

function MediaStatus({ failed }: { readonly failed: boolean }): React.JSX.Element {
  const { t } = useTranslation('creation')
  return (
    <div
      className="text-muted-foreground grid h-full min-h-28 place-items-center text-xs"
      role="status"
    >
      {failed ? (
        t('assets.mediaFailed')
      ) : (
        <>
          <LoaderCircleIcon className="size-5 animate-spin" aria-hidden />
          <span className="sr-only">{t('assets.mediaLoading')}</span>
        </>
      )}
    </div>
  )
}

export function AssetMedia({
  asset,
  ports,
  detail = false
}: {
  readonly asset: MediaPreviewView
  readonly ports: AssetContentPort
  readonly detail?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const [visible, setVisible] = useState(detail)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const wallPreviewAllowed = asset.mediaType === 'image' && asset.byteSize <= WALL_PREVIEW_MAX_BYTES

  useEffect(() => {
    if (detail || !wallPreviewAllowed || visible) return
    const host = hostRef.current
    if (!host || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true)
      },
      { rootMargin: '200px' }
    )
    observer.observe(host)
    return () => observer.disconnect()
  }, [detail, visible, wallPreviewAllowed])

  const shouldLoad = detail || (wallPreviewAllowed && visible)
  const content = useAssetContent(ports, asset, shouldLoad, !detail)
  if (!shouldLoad) {
    return (
      <div ref={hostRef} className="text-muted-foreground grid size-full place-items-center">
        {asset.mediaType === 'video' ? (
          <VideoIcon className="size-7" aria-hidden />
        ) : (
          <ImageIcon className="size-7" aria-hidden />
        )}
      </div>
    )
  }
  if (content.failed || !content.url) return <MediaStatus failed={content.failed} />
  return asset.mediaType === 'image' ? (
    <img
      src={content.url}
      alt={t('assets.mediaAlt', { id: asset.id })}
      className={detail ? 'size-full object-contain' : 'size-full object-cover'}
    />
  ) : (
    <video
      src={content.url}
      aria-label={t('assets.mediaAlt', { id: asset.id })}
      controls
      playsInline
      className="size-full object-contain"
    />
  )
}

export function AssetCard({
  asset,
  ports,
  selecting,
  selected,
  onSelect,
  onOpen
}: {
  readonly asset: MediaAssetView
  readonly ports: AssetLibraryPorts
  readonly selecting: boolean
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onOpen: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  return (
    <li data-testid="asset-card" className="group min-w-0">
      <div className="bg-muted relative aspect-[4/3] overflow-hidden rounded-xl border">
        <AssetMedia asset={asset} ports={ports} />
        {selecting ? (
          <label className="bg-background/90 absolute top-2 left-2 grid size-8 place-items-center rounded-md shadow-sm">
            <input
              type="checkbox"
              checked={selected}
              onChange={onSelect}
              aria-label={t('assets.selectOne', { id: asset.id })}
              className="size-4"
            />
          </label>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            aria-label={t('assets.open', { id: asset.id })}
            className="focus-visible:ring-ring absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-inset"
          />
        )}
        <span className="bg-background/90 text-foreground absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] shadow-sm">
          {asset.mediaType === 'image' ? (
            <ImageIcon className="size-3" aria-hidden />
          ) : (
            <VideoIcon className="size-3" aria-hidden />
          )}
          {t(`assets.media.${asset.mediaType}`)}
        </span>
      </div>
      <div className="mt-2 flex min-w-0 items-center justify-between gap-2 px-0.5 text-xs">
        <span className="truncate font-medium">{asset.creator.displayName}</span>
        <time className="text-muted-foreground shrink-0" dateTime={asset.createdAt}>
          {new Date(asset.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
      </div>
    </li>
  )
}
