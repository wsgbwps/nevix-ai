import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckIcon, ImageIcon, LoaderCircleIcon, VideoIcon } from 'lucide-react'
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
  const wallPreviewAllowed = asset.byteSize <= WALL_PREVIEW_MAX_BYTES

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
      controls={detail}
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
          // The whole card toggles: a 16px box is a poor hit target, and the
          // focus ring belongs on the card the way it is on the open button.
          <label className="has-[:focus-visible]:ring-ring absolute inset-0 cursor-pointer rounded-xl outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset">
            <input
              type="checkbox"
              checked={selected}
              onChange={onSelect}
              aria-label={t('assets.selectOne', { id: asset.id })}
              // Not `sr-only`: its clip-path would empty the hit region, and
              // this input is the card's click target rather than decoration.
              className="size-full cursor-pointer opacity-0"
            />
            <span
              aria-hidden
              className={`pointer-events-none absolute top-2 left-2 grid size-4 place-items-center rounded-[4px] border ${
                selected ? 'border-primary bg-primary text-primary-foreground' : 'bg-background/80'
              }`}
            >
              {selected ? <CheckIcon className="size-3" aria-hidden /> : null}
            </span>
          </label>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            aria-label={t('assets.open', { id: asset.id })}
            className="focus-visible:ring-ring absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-inset"
          />
        )}
      </div>
    </li>
  )
}
