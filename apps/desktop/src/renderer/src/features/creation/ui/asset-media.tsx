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

export type MediaPreviewView = Pick<MediaAssetView, 'id' | 'mediaType'>

/**
 * The wall's fixed variant per kind: the lightweight image variant, or the
 * untouched original that Chromium then ranges over (#291).
 */
function wallPurpose(asset: MediaPreviewView): AssetDisplayPurpose {
  return asset.mediaType === 'image' ? 'thumbnail' : 'preview'
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function MediaPlaceholder({ asset }: { readonly asset: MediaPreviewView }): React.JSX.Element {
  return (
    <div
      data-testid="media-placeholder"
      className="text-muted-foreground grid size-full place-items-center"
    >
      {asset.mediaType === 'video' ? (
        <VideoIcon className="size-7" aria-hidden />
      ) : (
        <ImageIcon className="size-7" aria-hidden />
      )}
    </div>
  )
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
      // A card's own open overlay covers the whole card, so the verdict has to
      // outrank it or Retry could never be clicked. Only the button takes
      // pointer events: the rest of a failed card still opens its detail, and
      // stays selectable in the Asset Library's batch mode.
      <div
        className="text-muted-foreground pointer-events-none relative z-20 grid h-full min-h-28 place-items-center gap-2 p-2 text-center text-xs"
        role="status"
      >
        {/* One generic verdict for every refusal: why it is gone is the
            server's business, not something a card explains. */}
        <span>{t(failure === 'retryable' ? 'assets.mediaFailed' : 'assets.mediaUnavailable')}</span>
        {failure === 'retryable' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="pointer-events-auto"
            onClick={onRetry}
          >
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
  hovered = false,
  onUnavailable
}: {
  readonly asset: MediaPreviewView
  readonly ports: AssetDisplayPort
  readonly detail?: boolean
  /** The wall card's pointer rests on this card; a detail never hovers. */
  readonly hovered?: boolean
  readonly onUnavailable?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  // Entering the near-visible range authorizes the card once and is never
  // undone, so scrolling cannot re-authorize a wall.
  const [visible, setVisible] = useState(detail)
  // The same range, tracked both ways, so playback is bounded by where the card
  // is rather than by hover bookkeeping. Chromium ends the hover itself when a
  // card scrolls out from under the cursor; this covers the same exit.
  const [nearVisible, setNearVisible] = useState(detail)
  // Visible content, not metadata: a card paints its placeholder until an image
  // decodes or a video has a frame. A detail is deliberate — it paints the
  // element at once, so an opened video's controls are usable immediately.
  const [decoded, setDecoded] = useState(false)
  const isImage = asset.mediaType === 'image'
  const pending = !decoded && (isImage || !detail)
  // Subscribed, not read once: a preference that turns on mid-hover stops the
  // card where it stands.
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const purpose = detail ? 'preview' : wallPurpose(asset)

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReducedMotion(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (detail) return
    const host = hostRef.current
    if (!host || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      setNearVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const intersecting = entries.some((entry) => entry.isIntersecting)
        setNearVisible(intersecting)
        if (intersecting) setVisible(true)
      },
      { rootMargin: '200px' }
    )
    observer.observe(host)
    return () => observer.disconnect()
  }, [detail])

  const shouldLoad = detail || visible
  const display = useAssetDisplay(ports, asset, {
    enabled: shouldLoad,
    queued: !detail,
    purpose,
    onUnavailable
  })

  // Playback belongs to the pointer, and the source is left alone so a brief
  // re-hover reuses the browser's own buffer. Pausing in the cleanup is what
  // stops the card on leave, on scrolling away, and on unmount.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !hovered || !nearVisible || reducedMotion) return
    // A rejected play is not a media failure — the element's own `error` event
    // is that signal — and pausing mid-request rejects with an AbortError.
    void video.play().catch(() => undefined)
    return () => {
      video.pause()
      // A source that never produced a frame has no position to rewind.
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) video.currentTime = 0
    }
  }, [hovered, nearVisible, reducedMotion, display.url])

  const renderContent = (): React.JSX.Element => {
    if (!shouldLoad) return <MediaPlaceholder asset={asset} />
    if (display.failure !== null || display.url === null) {
      return <MediaStatus failure={display.failure} onRetry={display.retry} />
    }
    const url = display.url
    const mediaLabel = t('assets.mediaAlt', { id: asset.id })
    const objectFit = detail ? 'object-contain' : 'object-cover'
    return (
      <>
        {pending ? (
          isImage ? (
            <MediaStatus failure={null} onRetry={display.retry} />
          ) : (
            <MediaPlaceholder asset={asset} />
          )
        ) : null}
        {isImage ? (
          <img
            src={url}
            alt={mediaLabel}
            className={`size-full ${objectFit} ${pending ? 'invisible' : ''}`}
            onLoad={() => setDecoded(true)}
            // A grant the element will not paint is worth exactly one fresh
            // authorization before the card concedes.
            onError={display.reportElementError}
          />
        ) : (
          <video
            ref={videoRef}
            src={url}
            aria-label={mediaLabel}
            controls={detail}
            // The wall previews; the detail is where playback is deliberate.
            muted={!detail}
            loop={!detail}
            preload={detail ? 'auto' : 'metadata'}
            playsInline
            className={`size-full ${objectFit} ${pending ? 'invisible' : ''}`}
            onLoadedData={() => setDecoded(true)}
            onError={display.reportElementError}
          />
        )}
      </>
    )
  }

  // One element for the card's whole life, whatever it paints inside it: the
  // near-visible observer watches it, and an element React replaced on a branch
  // change would leave that observer reporting a detached node forever.
  return (
    <div ref={hostRef} className={shouldLoad ? 'relative size-full' : 'size-full'}>
      {renderContent()}
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
  // Hover is tracked on the card, not on the media: the open button covers the
  // card, so the element itself never receives the pointer.
  const [hovered, setHovered] = useState(false)
  return (
    <li data-testid="asset-card" className="group min-w-0">
      <div
        className="bg-muted relative aspect-[4/3] overflow-hidden rounded-xl border"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <AssetMedia asset={asset} ports={ports} hovered={hovered} onUnavailable={onUnavailable} />
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
