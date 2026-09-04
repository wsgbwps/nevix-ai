import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '../../../components/ui/dialog'
import type { ReferenceMaterialView } from '../api/go-creation-http'
import type { PromptMentionCandidate } from '../model/prompt-document'
import { ReferenceKindIcon } from './reference-kind-icon'
import { hoverPreviewRect } from './reference-preview-geometry'

interface MentionHover {
  readonly materialId: string
  readonly anchor: HTMLElement
}

export function ReferenceMaterialPreview({
  materials,
  candidates,
  thumbnails,
  hover,
  openMaterialId,
  returnFocus,
  onOpenChange,
  loadPreviewBlob
}: {
  readonly materials: readonly ReferenceMaterialView[]
  readonly candidates: readonly PromptMentionCandidate[]
  readonly thumbnails: Readonly<Record<string, string>>
  readonly hover: MentionHover | null
  readonly openMaterialId: string | null
  readonly returnFocus: HTMLElement | null
  readonly onOpenChange: (open: boolean) => void
  readonly loadPreviewBlob: (materialId: string, signal?: AbortSignal) => Promise<Blob | null>
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const [attempt, setAttempt] = useState(0)
  const [full, setFull] = useState<{
    readonly materialId: string
    readonly attempt: number
    readonly status: 'failed' | 'ready'
    readonly url: string | null
  } | null>(null)
  const cachedUrl = useRef<{ readonly materialId: string; readonly url: string } | null>(null)
  const byId = useMemo(
    () => new Map(materials.map((material) => [material.id, material] as const)),
    [materials]
  )
  const labelById = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.materialId, candidate.label] as const)),
    [candidates]
  )

  useEffect(
    () => () => {
      if (cachedUrl.current !== null) URL.revokeObjectURL(cachedUrl.current.url)
    },
    []
  )

  useEffect(() => {
    if (cachedUrl.current !== null && !byId.has(cachedUrl.current.materialId)) {
      URL.revokeObjectURL(cachedUrl.current.url)
      cachedUrl.current = null
      setFull(null)
    }
  }, [byId])

  useEffect(() => {
    if (openMaterialId === null || !byId.has(openMaterialId)) return
    if (cachedUrl.current?.materialId === openMaterialId) {
      setFull({
        materialId: openMaterialId,
        attempt,
        status: 'ready',
        url: cachedUrl.current.url
      })
      return
    }
    if (cachedUrl.current !== null) {
      URL.revokeObjectURL(cachedUrl.current.url)
      cachedUrl.current = null
    }
    const controller = new AbortController()
    void loadPreviewBlob(openMaterialId, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return
        const url = blob === null ? null : URL.createObjectURL(blob)
        if (url !== null) cachedUrl.current = { materialId: openMaterialId, url }
        setFull({
          materialId: openMaterialId,
          attempt,
          status: url === null ? 'failed' : 'ready',
          url
        })
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFull({ materialId: openMaterialId, attempt, status: 'failed', url: null })
        }
      })
    return () => controller.abort()
  }, [attempt, byId, loadPreviewBlob, openMaterialId])

  const openMaterial = openMaterialId === null ? null : (byId.get(openMaterialId) ?? null)
  const openLabel = openMaterialId === null ? '' : (labelById.get(openMaterialId) ?? '')
  const currentFull = full?.materialId === openMaterialId && full.attempt === attempt ? full : null

  return (
    <>
      {hover !== null && (
        <DelayedHoverPreview
          key={hover.materialId}
          material={byId.get(hover.materialId) ?? null}
          label={labelById.get(hover.materialId) ?? ''}
          thumbnail={thumbnails[hover.materialId] ?? null}
          anchor={hover.anchor}
        />
      )}
      <Dialog open={openMaterialId !== null} onOpenChange={onOpenChange}>
        <DialogContent
          data-testid="reference-full-preview"
          className="max-h-[calc(100vh-2rem)] max-w-[min(900px,calc(100vw-2rem))] overflow-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            returnFocus?.focus()
          }}
        >
          <DialogTitle>{t('composer.mention.preview.title', { label: openLabel })}</DialogTitle>
          <DialogDescription className="sr-only">
            {openMaterial?.fileName ?? openLabel}
          </DialogDescription>
          {currentFull === null && (
            <p role="status" className="text-muted-foreground py-12 text-center text-sm">
              {t('composer.mention.preview.loading')}
            </p>
          )}
          {currentFull?.status === 'failed' && (
            <div role="alert" className="grid justify-items-center gap-3 py-12">
              <p>{t('composer.mention.preview.failed')}</p>
              <button
                type="button"
                className="rounded-lg border px-3 py-1.5"
                onClick={() => setAttempt((value) => value + 1)}
              >
                {t('composer.mention.preview.retry')}
              </button>
            </div>
          )}
          {currentFull?.status === 'ready' && currentFull.url !== null && openMaterial !== null && (
            <FullMedium material={openMaterial} label={openLabel} url={currentFull.url} />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function DelayedHoverPreview(props: React.ComponentProps<typeof HoverPreview>): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(true), 250)
    return () => window.clearTimeout(timeout)
  }, [])
  return visible ? <HoverPreview {...props} /> : <></>
}

function HoverPreview({
  material,
  label,
  thumbnail,
  anchor
}: {
  readonly material: ReferenceMaterialView | null
  readonly label: string
  readonly thumbnail: string | null
  readonly anchor: HTMLElement
}): React.JSX.Element | null {
  const { t } = useTranslation('creation')
  if (material === null) return null
  const intrinsic =
    material.kind === 'image'
      ? { width: material.widthPx ?? 360, height: material.heightPx ?? 240 }
      : { width: 360, height: 120 }
  const rect = hoverPreviewRect(anchor.getBoundingClientRect(), intrinsic, {
    width: window.innerWidth,
    height: window.innerHeight
  })
  const style = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  }
  return (
    <div
      data-testid="reference-hover-preview"
      className="bg-popover text-popover-foreground pointer-events-none fixed z-40 overflow-hidden rounded-xl border shadow-2xl"
      style={style}
    >
      {material.kind === 'image' && thumbnail !== null ? (
        <img src={thumbnail} alt="" className="size-full object-contain" />
      ) : (
        <div className="grid size-full place-content-center justify-items-center gap-2 p-4">
          <ReferenceKindIcon kind={material.kind} className="size-7" />
          {material.durationMs !== null && (
            <span className="text-muted-foreground text-xs">
              {t('composer.mention.preview.duration', {
                seconds: Math.round(material.durationMs / 100) / 10
              })}
            </span>
          )}
        </div>
      )}
      <span className="absolute right-2 bottom-2 rounded-md bg-black/65 px-2 py-1 text-xs text-white">
        {label}
      </span>
    </div>
  )
}

function FullMedium({
  material,
  label,
  url
}: {
  readonly material: ReferenceMaterialView
  readonly label: string
  readonly url: string
}): React.JSX.Element {
  if (material.kind === 'image') {
    return <img src={url} alt={label} className="max-h-[75vh] w-full object-contain" />
  }
  if (material.kind === 'video') {
    return <video src={url} aria-label={label} className="max-h-[75vh] w-full" controls />
  }
  return <audio src={url} aria-label={label} className="w-full" controls />
}
