import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckIcon, ImageIcon, LoaderCircleIcon, VideoIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import type { AssetDisplayPurpose, MediaAssetView } from '../api/asset-library-http'
import {
  useAssetDisplay,
  type AssetDisplayFailure,
  type AssetDisplayPort
} from './use-asset-display'

export type MediaPreviewView = Pick<MediaAssetView, 'id' | 'mediaType' | 'byteSize'>

/** Above this the wall shows a video's icon rather than streaming it whole. */
const WALL_VIDEO_MAX_BYTES = 8 * 1024 * 1024

/**
 * A video has no lightweight variant yet (#291), so its wall card still
 * streams the original and an oversized one keeps the placeholder instead.
 * An image card costs the same whatever the original weighs, because the wall
 * paints the fixed 320px variant rather than the file.
 */
function wallPurpose(asset: MediaPreviewView): AssetDisplayPurpose | null {
  if (asset.mediaType === 'image') return 'thumbnail'
  return asset.byteSize <= WALL_VIDEO_MAX_BYTES ? 'preview' : null
}

function MediaStatus({
  failure,
  onRetry
}: {
  readonly failure: AssetDisplayFailure | null
  readonly onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  if (failure !== null) {
    return (
      <div
        className="text-muted-foreground grid h-full min-h-28 place-items-center gap-2 p-2 text-center text-xs"
        role="status"
      >
        {/* One generic verdict for every refusal: why it is gone is the
            server's business, not something a card explains. */}
        <span>{t(failure === 'retryable' ? 'assets.mediaFailed' : 'assets.mediaUnavailable')}</span>
        {failure === 'retryable' ? (
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            {t('state.retry')}
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <div
      className="text-muted-foreground grid h-full min-h-28 place-items-center text-xs"
      role="status"
    >
      <LoaderCircleIcon className="size-5 animate-spin" aria-hidden />
      <span className="sr-only">{t('assets.mediaLoading')}</span>
    </div>
  )
}

export function AssetMedia({
  asset,
  ports,
  detail = false,
  onUnavailable
}: {
  readonly asset: MediaPreviewView
  readonly ports: AssetDisplayPort
  readonly detail?: boolean
  readonly onUnavailable?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const [visible, setVisible] = useState(detail)
  // Metadata readiness is not visible content: an image keeps its placeholder
  // until the bytes have decoded. Video frame readiness arrives with the hover
  // work (#291), so a video paints as it always has.
  const [decoded, setDecoded] = useState(false)
  const isImage = asset.mediaType === 'image'
  const pending = isImage && !decoded
  const hostRef = useRef<HTMLDivElement | null>(null)
  const purpose = detail ? 'preview' : wallPurpose(asset)

  useEffect(() => {
    if (detail || purpose === null || visible) return
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
  }, [detail, purpose, visible])

  const shouldLoad = purpose !== null && (detail || visible)
  const display = useAssetDisplay(ports, asset, {
    enabled: shouldLoad,
    queued: !detail,
    purpose: purpose ?? 'preview',
    onUnavailable
  })

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
  if (display.failure !== null || display.url === null) {
    return <MediaStatus failure={display.failure} onRetry={display.retry} />
  }
  const mediaLabel = t('assets.mediaAlt', { id: asset.id })
  const objectFit = detail ? 'object-contain' : 'object-cover'
  return (
    <div ref={hostRef} className="relative size-full">
      {pending ? <MediaStatus failure={null} onRetry={display.retry} /> : null}
      {isImage ? (
        <img
          src={display.url}
          alt={mediaLabel}
          className={`size-full ${objectFit} ${pending ? 'invisible' : ''}`}
          onLoad={() => setDecoded(true)}
          // A grant the element will not paint is worth exactly one fresh
          // authorization before the card concedes.
          onError={display.reportElementError}
        />
      ) : (
        <video
          src={display.url}
          aria-label={mediaLabel}
          controls={detail}
          playsInline
          className={`size-full ${objectFit}`}
          onError={display.reportElementError}
        />
      )}
    </div>
  )
}

export function AssetCard({
  asset,
  ports,
  selecting,
  selected,
  onSelect,
  onOpen,
  onUnavailable
}: {
  readonly asset: MediaAssetView
  readonly ports: AssetDisplayPort
  readonly selecting: boolean
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onOpen: () => void
  readonly onUnavailable?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  return (
    <li data-testid="asset-card" className="group min-w-0">
      <div className="bg-muted relative aspect-[4/3] overflow-hidden rounded-xl border">
        <AssetMedia asset={asset} ports={ports} onUnavailable={onUnavailable} />
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
