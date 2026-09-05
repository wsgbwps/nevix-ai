import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import gsap from 'gsap'
import {
  ArrowUpIcon,
  BoxIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronsDownIcon,
  Clock3Icon,
  ImageIcon,
  Link2Icon,
  SlidersHorizontalIcon,
  SparklesIcon,
  TriangleAlertIcon,
  VideoIcon
} from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle
} from '../../../components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '../../../components/ui/dropdown-menu'
import type { CapabilityMediaMode, CapabilityReason } from '../api/capability-manifest-http'
import {
  mediaCapability,
  modeCandidates,
  modelCandidates,
  publishedSize,
  resolutionCandidates,
  type DraftMediaType
} from '../model/capability'
import type { CreationWorkbenchController } from '../model/use-workbench'
import { modeKeys } from '../i18n/mode-keys'
import { ComposerMenuContent } from './composer-menu-content'
import { PromptEditor } from './prompt-editor'
import { ReferenceMaterialPreview } from './reference-material-preview'
import { ratioGlyphDiagonalSize, ratioGlyphSize } from './ratio-glyph'
import { ReferenceDeck } from './reference-deck'
import { useComposerPresence } from './use-composer-presence'

// Dynamic verdict vocabularies resolve through explicit key maps — the same
// shape the provider-connection surface uses for wire codes.

const reasonKeys = {
  not_configured: 'composer.unavailable.reasons.not_configured',
  checking: 'composer.unavailable.reasons.checking',
  credential_invalid: 'composer.unavailable.reasons.credential_invalid',
  credential_unavailable: 'composer.unavailable.reasons.credential_unavailable',
  connection_paused: 'composer.unavailable.reasons.connection_paused',
  model_unavailable: 'composer.unavailable.reasons.model_unavailable'
} as const

const actionKeys = {
  wait: 'composer.unavailable.actions.wait',
  contact_admin: 'composer.unavailable.actions.contact_admin'
} as const

// Control-row and menu surfaces from the accepted prototype (6e465e8),
// expressed through theme tokens: an h-8 pill per capability, menus opening
// upward as compact rounded-xl surfaces in the reference design's proportions.
const controlClass =
  'group flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-accent px-2.5 text-[10px] text-foreground/80 outline-none transition-colors hover:bg-input data-[state=open]:bg-input'

const staleTriggerClass = 'border-warning/70 bg-accent text-warning'

// Menus only override the base surface's width, padding, and shadow —
// radius and surface tokens come from ComposerMenuContent's baseClass.
const menuClass = 'w-52 shadow-2xl'
const menuLabelClass = 'text-muted-foreground px-2.5 pb-1.5 pt-1 text-[11px]'
const menuItemClass = 'h-9 cursor-pointer rounded-lg px-2.5 text-[13px]'

// Dual-state geometry (px). These constants mirror the Tailwind classes on
// the same elements (h-28, min-h-20, py-1 + leading-5, bottom-4) and drift
// silently if changed apart. The deck keeps the compact row a constant 40px
// with or without references; the submit circle centers on the h-8 control
// row when expanded (the padding edge itself) and on the main row when
// compact.
/** Expanded column width (px); the workbench page's gallery container aligns to it. */
export const EXPANDED_MAX_WIDTH = 992
const COMPACT_MAX_WIDTH = 622
const ROW_HEIGHT = 80
const ROW_COMPACT_HEIGHT = 40
const PROMPT_HEIGHT = 112
const PROMPT_COMPACT_HEIGHT = 28
const SUBMIT_BOTTOM = 16
const SUBMIT_SIZE = 32

/**
 * The fixed bottom Composer (issue #177, prototype 6e465e8): prompt text
 * area, the inline reference deck, and the capability controls expanding
 * upward from the bottom row. Every candidate comes from the Capability
 * Manifest; draft values the manifest removed stay displayed with a stable
 * stale marker and are never rewritten. This slice creates no Generation
 * Task — the submit affordance stays disabled rather than faking success.
 *
 * The surface is dual-state (完整态/紧凑态, see apps/desktop/CONTEXT.md):
 * `useComposerPresence` owns presence; this component tweens the geometry
 * and hosts the back-to-bottom pill at the container's top-right corner.
 */
export function CreationComposer({
  workbench,
  scrollerRef,
  wrapperRef,
  statusNotice,
  backToBottomVisible,
  newTaskWaiting,
  onBackToBottom
}: {
  readonly workbench: CreationWorkbenchController
  readonly scrollerRef: React.RefObject<HTMLDivElement | null>
  /** The page measures this wrapper for the scroller's bottom reserve. */
  readonly wrapperRef: React.RefObject<HTMLDivElement | null>
  /** Lives outside the scroller so dynamic notices cannot move a virtualized reading anchor. */
  readonly statusNotice?: ReactNode
  readonly backToBottomVisible: boolean
  readonly newTaskWaiting: boolean
  readonly onBackToBottom: () => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const { draft, manifest, manifestStatus, staleFields } = workbench
  const rowRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const promptRef = useRef<HTMLDivElement>(null)
  const controlClipRef = useRef<HTMLDivElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)
  const { expanded, pin } = useComposerPresence({ scrollerRef, rootRef: cardRef })
  const mountedRef = useRef(false)
  const [mentionHover, setMentionHover] = useState<{
    readonly materialId: string
    readonly anchor: HTMLElement
  } | null>(null)
  const [previewMaterialId, setPreviewMaterialId] = useState<string | null>(null)
  const [previewReturnFocus, setPreviewReturnFocus] = useState<HTMLElement | null>(null)

  useEffect(() => {
    const wrap = wrapperRef.current
    const row = rowRef.current
    const prompt = promptRef.current
    const clip = controlClipRef.current
    const submit = submitRef.current
    if (wrap === null || row === null || prompt === null || clip === null || submit === null) {
      return
    }

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // The first pass settles without animation; only transitions glide.
    const animate = mountedRef.current && !reduce
    mountedRef.current = true
    const spring = { duration: animate ? 0.36 : 0, ease: 'back.out(1.5)' } as const
    const rowTarget = expanded ? ROW_HEIGHT : ROW_COMPACT_HEIGHT
    // On expand, hand animated properties back to the document so later
    // content changes never freeze a stale px.
    const settle = (el: HTMLElement, prop: string): (() => void) | undefined =>
      expanded ? () => gsap.set(el, { clearProps: prop }) : undefined

    const tweens: gsap.core.Tween[] = [
      gsap.to(wrap, {
        maxWidth: expanded ? EXPANDED_MAX_WIDTH : COMPACT_MAX_WIDTH,
        ...spring,
        onComplete: settle(wrap, 'maxWidth')
      }),
      gsap.to(row, {
        minHeight: rowTarget,
        ...spring,
        onComplete: settle(row, 'minHeight')
      }),
      gsap.to(prompt, {
        height: expanded ? PROMPT_HEIGHT : PROMPT_COMPACT_HEIGHT,
        y: expanded ? 0 : (rowTarget - PROMPT_COMPACT_HEIGHT) / 2,
        ...spring
      }),
      gsap.to(clip, {
        height: expanded ? 'auto' : 0,
        autoAlpha: expanded ? 1 : 0,
        ...spring,
        onComplete: settle(clip, 'height')
      }),
      gsap.to(submit, {
        bottom: expanded ? SUBMIT_BOTTOM : SUBMIT_BOTTOM + (rowTarget - SUBMIT_SIZE) / 2,
        ...spring
      })
    ]
    return () => {
      for (const tween of tweens) tween.kill()
    }
  }, [expanded, wrapperRef])

  const media = draft.mediaType
  const capability = media === null ? null : mediaCapability(manifest, media)
  const mediaAvailable = capability?.available === true

  const noMediaAvailable =
    manifestStatus === 'ready' &&
    manifest !== null &&
    !manifest.image.available &&
    !manifest.video.available

  const unavailableLine = ((): string | null => {
    if (manifestStatus === 'unavailable') return String(t('composer.manifestUnavailable'))
    if (noMediaAvailable && manifest !== null) {
      const worst = manifest.image.available === false ? manifest.image : manifest.video
      const reason = worst.reason !== null ? String(t(reasonKeys[worst.reason])) : ''
      const action = worst.action !== null ? String(t(actionKeys[worst.action])) : ''
      return String(t('composer.unavailable.template', { reason, action }))
    }
    return null
  })()

  const promptCap =
    capability?.available === true && capability.prompt ? capability.prompt.maxChars : 2000
  const controls = media !== null && mediaAvailable && manifestStatus === 'ready'

  return (
    <div
      ref={wrapperRef}
      className="absolute right-6 bottom-5 left-6 z-20 mx-auto max-w-[992px]"
      data-testid="composer"
    >
      {statusNotice}
      {backToBottomVisible && (
        <button
          type="button"
          data-testid="back-to-bottom"
          onClick={onBackToBottom}
          className="bg-card border-border/60 text-muted-foreground hover:text-foreground animate-in fade-in slide-in-from-bottom-1 absolute right-0 bottom-full z-20 mb-2 flex h-8 items-center gap-1 rounded-full border px-3 text-[10px] shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
        >
          {t(newTaskWaiting ? 'gallery.newTaskAvailable' : 'gallery.backToBottom')}
          <ChevronsDownIcon className="size-3" aria-hidden />
        </button>
      )}
      <div
        ref={cardRef}
        // Blank-surface clicks expand and hand the caret to the prompt.
        onClick={(event) => {
          if (
            (event.target as HTMLElement).closest(
              'button, textarea, input, a, [contenteditable="true"]'
            ) !== null
          ) {
            return
          }
          document.getElementById('composer-prompt')?.focus()
        }}
        className="bg-card relative rounded-[22px] border p-4 shadow-2xl"
      >
        {unavailableLine !== null && (
          <p
            role="status"
            data-testid="composer-unavailable"
            className="text-warning mb-2 text-[11px]"
          >
            {unavailableLine}
          </p>
        )}
        <div ref={rowRef} className="flex min-h-20 items-start gap-3">
          <div className="min-w-0 shrink">
            <ReferenceDeck
              compact={!expanded}
              bindings={draft.references}
              materials={workbench.materials}
              thumbnails={workbench.thumbnails}
              thumbnailStates={workbench.thumbnailStates}
              onRetainThumbnail={workbench.retainMaterialThumbnail}
              onRequestThumbnail={workbench.requestMaterialThumbnail}
              cap={workbench.deckCap}
              allowedKinds={workbench.allowedKinds}
              onAddFiles={workbench.addMaterials}
              onReplace={workbench.replaceMaterial}
              onDropResult={workbench.addResultAsMaterial}
              mentionedMaterialIds={workbench.mentionedMaterialIds}
              onDragHover={pin}
              onRemove={workbench.removeMaterial}
            />
            {staleFields.has('references') && draft.references.length > 0 && (
              <p
                role="note"
                data-testid="composer-deck-stale"
                className="text-warning mt-1 max-w-56 text-[10px] leading-4"
              >
                {t('composer.stale.references')}
              </p>
            )}
            {workbench.materialUploadFailed && (
              <p
                role="alert"
                data-testid="composer-upload-failed"
                className="text-destructive mt-1 max-w-56 text-[10px] leading-4"
              >
                {t('composer.deck.uploadFailed')}
              </p>
            )}
            {workbench.materialDropRejection && (
              <p
                role="status"
                data-testid="composer-drop-rejected"
                className="text-warning mt-1 max-w-56 text-[10px] leading-4"
              >
                {t('composer.deck.dropRejected', {
                  added: workbench.materialDropRejection.added,
                  rejected: workbench.materialDropRejection.rejected
                })}
              </p>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div ref={promptRef} className="h-28 w-full">
              <PromptEditor
                document={draft.promptDocument}
                documentKey={`${workbench.ports?.userId ?? ''}:${workbench.composingNew ? 'new' : (workbench.selectedId ?? 'inactive')}`}
                candidates={workbench.mentionCandidates}
                thumbnails={workbench.thumbnails}
                maxChars={promptCap}
                placeholder={
                  draft.references.length > 0
                    ? String(t('composer.promptPlaceholderWithRefs'))
                    : String(t('composer.promptPlaceholder'))
                }
                label={String(t('composer.promptLabel'))}
                emptyLabel={String(t('composer.mention.empty'))}
                noResultsLabel={String(t('composer.mention.noResults'))}
                onChange={(promptDocument) => workbench.patchDraft({ promptDocument })}
                onPreview={(materialId, focusTarget) => {
                  setPreviewReturnFocus(focusTarget)
                  setPreviewMaterialId(materialId)
                }}
                onMentionHover={(materialId, anchor) =>
                  setMentionHover(
                    materialId !== null && anchor !== null ? { materialId, anchor } : null
                  )
                }
              />
            </div>
            {(workbench.promptLength >= Math.max(0, workbench.promptMaxChars - 100) ||
              workbench.promptLength > workbench.promptMaxChars) && (
              <p
                className={`mt-1 text-right text-[10px] ${workbench.promptInvalid ? 'text-destructive' : 'text-muted-foreground'}`}
                role={workbench.promptInvalid ? 'alert' : undefined}
              >
                {t('composer.mention.length', {
                  current: workbench.promptLength,
                  max: workbench.promptMaxChars
                })}
              </p>
            )}
          </div>
        </div>
        {/* The control row is the only piece the compact form hides; GSAP
            clips this wrapper to zero while the submit circle (anchored to
            the card, outside the clip) glides up to the prompt row. */}
        <div ref={controlClipRef} className="overflow-hidden">
          <div className="mt-2 flex min-w-0 items-center gap-1.5 border-t pt-2">
            <MediaMenu
              workbench={workbench}
              triggerClass={`${controlClass} ${draft.mediaType !== null && !staleFields.has('mediaType') ? 'text-cyan-600 dark:text-cyan-300' : ''} ${staleFields.has('mediaType') ? staleTriggerClass : ''}`}
            />
            {media !== null && <ModelMenu workbench={workbench} triggerClass={controlClass} />}
            {media === 'video' && controls && <ModeMenu workbench={workbench} />}
            {media !== null && controls && <ParamsMenu workbench={workbench} />}
            {media === 'video' && controls && <DurationMenu workbench={workbench} />}
            {/* Reserves the absolute submit circle's slot so the longest
                capability pill never underlaps it. */}
            <div className="ml-auto size-8 shrink-0" aria-hidden />
          </div>
        </div>
        <button
          type="button"
          ref={submitRef}
          disabled={workbench.submitDisabled}
          onClick={workbench.submit}
          title={
            workbench.submitBlockedReason === 'stale'
              ? String(t('composer.stale.badge'))
              : workbench.submitBlockedReason === 'length' &&
                  workbench.promptLength > workbench.promptMaxChars
                ? String(t('composer.mention.overLimit', { max: workbench.promptMaxChars }))
                : workbench.submitBlockedReason === 'unavailable'
                  ? String(t('composer.unavailable.template', { reason: '', action: '' }))
                  : String(t('composer.submit'))
          }
          aria-label={String(t('composer.submit'))}
          aria-disabled={workbench.submitDisabled}
          data-testid="composer-submit"
          className={
            'absolute right-4 bottom-4 flex size-8 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 ' +
            (workbench.submitDisabled
              ? 'bg-accent text-muted-foreground'
              : 'bg-cyan-600 text-white hover:bg-cyan-500 dark:bg-cyan-500 dark:hover:bg-cyan-400')
          }
        >
          <ArrowUpIcon className="size-4" aria-hidden />
        </button>
      </div>
      {workbench.referenceRecoveryShown && (
        <div
          role="status"
          className="bg-card text-warning absolute right-0 bottom-full mb-2 rounded-lg border px-3 py-2 text-[11px] shadow-lg"
        >
          <button type="button" onClick={workbench.dismissReferenceRecovery}>
            {t('composer.mention.recovered')}
          </button>
        </div>
      )}
      <ReferenceMaterialPreview
        materials={workbench.materials}
        candidates={workbench.mentionCandidates}
        thumbnails={workbench.thumbnails}
        hover={mentionHover}
        openMaterialId={previewMaterialId}
        returnFocus={previewReturnFocus}
        onOpenChange={(open) => {
          if (!open) setPreviewMaterialId(null)
        }}
        loadPreviewBlob={workbench.loadMaterialPreviewBlob}
      />
      <Dialog
        open={workbench.pendingMaterialRemoval !== null}
        onOpenChange={(open) => {
          if (!open) workbench.dismissMaterialRemoval()
        }}
      >
        <DialogContent>
          <DialogTitle>{t('composer.mention.removeTitle')}</DialogTitle>
          <DialogDescription>
            {t('composer.mention.removeBody', {
              count: workbench.pendingMaterialRemoval?.mentionCount ?? 0
            })}
          </DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <button type="button" className="rounded-lg border px-3 py-1.5">
                {t('composer.mention.removeCancel')}
              </button>
            </DialogClose>
            <button
              type="button"
              className="bg-destructive text-destructive-foreground rounded-lg px-3 py-1.5"
              onClick={workbench.confirmMaterialRemoval}
            >
              {t('composer.mention.removeConfirm')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function MediaMenu({
  workbench,
  triggerClass
}: {
  readonly workbench: CreationWorkbenchController
  readonly triggerClass: string
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const { manifest, manifestStatus, draft, staleFields } = workbench
  const options: ReadonlyArray<{
    readonly media: DraftMediaType
    readonly available: boolean | null
  }> = [
    { media: 'image', available: manifest === null ? null : manifest.image.available },
    { media: 'video', available: manifest === null ? null : manifest.video.available }
  ]
  const label =
    draft.mediaType === null
      ? String(t('composer.media.label'))
      : String(t(`composer.media.${draft.mediaType}`))
  const stale = staleFields.has('mediaType')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger data-testid="composer-media" className={triggerClass}>
        {draft.mediaType === 'video' ? (
          <VideoIcon className="size-3.5" aria-hidden />
        ) : draft.mediaType === 'image' ? (
          <ImageIcon className="size-3.5" aria-hidden />
        ) : null}
        <span className="max-w-40 truncate">{label}</span>
        {stale && <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />}
        <ChevronDownIcon
          className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </DropdownMenuTrigger>
      <ComposerMenuContent side="top" sideOffset={10} align="start" className={menuClass}>
        <DropdownMenuLabel className={menuLabelClass}>
          {t('composer.media.label')}
        </DropdownMenuLabel>
        {options.map(({ media, available }) => {
          const reason = manifest === null ? null : manifestImageVideoReason(manifest, media)
          return (
            <DropdownMenuItem
              key={media}
              disabled={available === false}
              className={menuItemClass}
              onSelect={() => workbench.setMediaType(media)}
            >
              {media === 'video' ? (
                <VideoIcon className="size-4" aria-hidden />
              ) : (
                <ImageIcon className="size-4" aria-hidden />
              )}
              {t(`composer.media.${media}`)}
              {available === false && reason !== null && (
                <span className="text-muted-foreground ml-auto flex items-center gap-1 text-[10px]">
                  <TriangleAlertIcon className="text-warning size-3" aria-hidden />
                  {t(reasonKeys[reason])}
                </span>
              )}
              {draft.mediaType === media && available !== false && (
                <CheckIcon className="ml-auto size-4" aria-hidden />
              )}
            </DropdownMenuItem>
          )
        })}
        {manifestStatus === 'unavailable' && (
          <DropdownMenuLabel className="text-muted-foreground text-[10px]">
            {t('composer.manifestUnavailable')}
          </DropdownMenuLabel>
        )}
      </ComposerMenuContent>
    </DropdownMenu>
  )
}

function manifestImageVideoReason(
  manifest: NonNullable<CreationWorkbenchController['manifest']>,
  media: DraftMediaType
): CapabilityReason | null {
  const entry = media === 'image' ? manifest.image : manifest.video
  return entry.available ? null : entry.reason
}

function ModelMenu({
  workbench,
  triggerClass
}: {
  readonly workbench: CreationWorkbenchController
  readonly triggerClass: string
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const { manifest, draft, staleFields } = workbench
  const media = draft.mediaType
  if (media === null) return <></>
  const candidates = modelCandidates(manifest, media)
  const staleModel = staleFields.has('model') ? draft.model : null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger data-testid="composer-model" className={triggerClass}>
        <BoxIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="max-w-40 truncate">{draft.model ?? t('composer.model.label')}</span>
        {staleModel !== null && <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />}
      </DropdownMenuTrigger>
      <ComposerMenuContent
        side="top"
        sideOffset={10}
        align="start"
        className="w-[360px] shadow-2xl"
      >
        <DropdownMenuLabel className={menuLabelClass}>
          {t('composer.model.label')}
          {draft.model !== null ? ` · ${draft.model}` : ''}
        </DropdownMenuLabel>
        {staleModel !== null && <StaleRow value={staleModel} />}
        {candidates.map((model) => (
          <DropdownMenuItem
            key={model}
            className="min-h-14 cursor-pointer rounded-xl px-3 py-2"
            onSelect={() => workbench.setModel(model)}
          >
            <span className="border-border bg-accent grid size-9 shrink-0 place-items-center rounded-lg border">
              <SparklesIcon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{model}</span>
            </span>
            {draft.model === model ? <CheckIcon className="size-4" aria-hidden /> : null}
          </DropdownMenuItem>
        ))}
        {candidates.length === 0 && staleModel === null && (
          <DropdownMenuLabel className="text-muted-foreground text-[10px]">
            {t('composer.manifestUnavailable')}
          </DropdownMenuLabel>
        )}
      </ComposerMenuContent>
    </DropdownMenu>
  )
}

function ModeMenu({
  workbench
}: {
  readonly workbench: CreationWorkbenchController
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const { manifest, draft, staleFields } = workbench
  const media = draft.mediaType
  if (media === null) return <></>
  const candidates = modeCandidates(manifest, media)
  const staleMode = staleFields.has('mode') ? draft.mode : null
  const label =
    draft.mode !== null && draft.mode in modeKeys
      ? t(modeKeys[draft.mode as CapabilityMediaMode])
      : (draft.mode ?? t('composer.mode.label'))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="composer-mode"
        className={`${controlClass} ${staleMode !== null ? staleTriggerClass : ''}`}
      >
        <SlidersHorizontalIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="max-w-40 truncate">{label}</span>
        {staleMode !== null && <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />}
        <ChevronDownIcon
          className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </DropdownMenuTrigger>
      <ComposerMenuContent side="top" sideOffset={10} align="start" className={menuClass}>
        <DropdownMenuLabel className={menuLabelClass}>{t('composer.mode.label')}</DropdownMenuLabel>
        {staleMode !== null && <StaleRow value={staleMode} />}
        {candidates.map((mode) => (
          <DropdownMenuItem
            key={mode}
            className={menuItemClass}
            onSelect={() => workbench.setMode(mode)}
          >
            <SlidersHorizontalIcon className="size-4" aria-hidden />
            {t(modeKeys[mode])}
            {draft.mode === mode ? <CheckIcon className="ml-auto size-4" aria-hidden /> : null}
          </DropdownMenuItem>
        ))}
      </ComposerMenuContent>
    </DropdownMenu>
  )
}

function ParamsMenu({
  workbench
}: {
  readonly workbench: CreationWorkbenchController
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const { draft, manifest, staleFields } = workbench
  const media = draft.mediaType
  const capability = media === null ? null : mediaCapability(manifest, media)
  if (media === null || capability === null || !capability.available) return <></>

  const ratios = capability.ratios ?? []
  // Resolution tiers are model-scoped: the selected model's own published
  // tiers, empty while the draft's model is stale so only the stale note
  // shows.
  const resolutions = resolutionCandidates(manifest, media, draft.model)
  const quantities = capability.quantities ?? []
  // The exact pixel size the server will submit for this selection; hidden
  // while any dimension is stale or the combination is unpublished.
  const size =
    media === 'image'
      ? publishedSize(manifest, media, draft.model, draft.ratio, draft.resolution)
      : null
  const staleRatio = staleFields.has('ratio') ? draft.ratio : null
  const staleResolution = staleFields.has('resolution') ? draft.resolution : null
  const staleQuantity = staleFields.has('quantity') ? draft.quantity : null
  const staleParams = staleRatio !== null || staleResolution !== null || staleQuantity !== null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="composer-params"
        aria-label={t('composer.params.label')}
        className={`${controlClass} ${staleParams ? staleTriggerClass : ''}`}
      >
        <RatioGlyph ratio={draft.ratio} max={14} />
        {media === 'image' && draft.ratio !== null && <span>{draft.ratio}</span>}
        {media === 'image' && draft.ratio !== null && draft.resolution !== null && <Separator />}
        {draft.resolution !== null && <span>{draft.resolution}</span>}
        {media === 'image' && draft.quantity !== null && (
          <>
            <Separator />
            <span>{draft.quantity}</span>
          </>
        )}
        {staleParams && <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />}
      </DropdownMenuTrigger>
      <ComposerMenuContent
        side="top"
        sideOffset={10}
        align="end"
        className="w-[420px] p-4 shadow-2xl"
      >
        <div className="grid gap-4">
          {media === 'image' && ratios.length > 0 && (
            <ParamGroup label={t('composer.params.ratio')}>
              {staleRatio !== null && <StaleRow value={staleRatio} />}
              <OptionStrip
                items={ratios}
                isSelected={(ratio) => ratio === draft.ratio}
                layout="h-[52px] flex-col gap-2.5"
                onSelect={(ratio) => workbench.patchDraft({ ratio })}
                render={(ratio) => (
                  <>
                    {/* Fixed-height slot: every glyph shares one band so the
                        labels below sit on one line across the strip. */}
                    <span className="flex h-4 shrink-0 items-center justify-center">
                      <RatioGlyph ratio={ratio} diagonal={16} />
                    </span>
                    <span className="text-[11px] leading-none">{ratio}</span>
                  </>
                )}
              />
            </ParamGroup>
          )}
          {resolutions.length > 0 && (
            <ParamGroup label={t('composer.params.resolution')}>
              {staleResolution !== null && <StaleRow value={staleResolution} />}
              <OptionStrip
                items={resolutions}
                isSelected={(resolution) => resolution === draft.resolution}
                layout="h-10 text-[13px]"
                onSelect={(resolution) => workbench.patchDraft({ resolution })}
                render={(resolution) => resolution}
              />
            </ParamGroup>
          )}
          {media === 'image' && quantities.length > 0 && (
            <ParamGroup label={t('composer.params.quantity')}>
              {staleQuantity !== null && <StaleRow value={String(staleQuantity)} />}
              <OptionStrip
                items={quantities}
                isSelected={(quantity) => quantity === draft.quantity}
                layout="h-9 text-[13px]"
                onSelect={(quantity) => workbench.patchDraft({ quantity })}
                render={(quantity) => quantity}
              />
            </ParamGroup>
          )}
          {size !== null && (
            <ParamGroup label={t('composer.params.size')}>
              <div
                data-testid="composer-params-size"
                className="bg-accent/60 flex items-center gap-2 rounded-xl p-1 text-xs"
              >
                <span className="bg-background/60 flex h-9 flex-1 items-center justify-between rounded-lg px-3">
                  <span className="text-muted-foreground">W</span>
                  <span className="text-[13px] font-medium">{size.width}</span>
                </span>
                <Link2Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
                <span className="bg-background/60 flex h-9 flex-1 items-center justify-between rounded-lg px-3">
                  <span className="text-muted-foreground">H</span>
                  <span className="text-[13px] font-medium">{size.height}</span>
                </span>
                <span className="text-muted-foreground pr-1 text-[11px]">PX</span>
              </div>
            </ParamGroup>
          )}
        </div>
      </ComposerMenuContent>
    </DropdownMenu>
  )
}

/** The prototype's dedicated video-length control, fed by manifest options. */
function DurationMenu({
  workbench
}: {
  readonly workbench: CreationWorkbenchController
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const { draft, manifest, staleFields } = workbench
  const capability = mediaCapability(manifest, 'video')
  if (capability === null || !capability.available) return <></>
  const durations = capability.durations ?? []
  if (durations.length === 0) return <></>
  const staleDuration = staleFields.has('durationSeconds') ? draft.durationSeconds : null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="composer-duration"
        aria-label={t('composer.params.duration')}
        className={`${controlClass} ${staleDuration !== null ? staleTriggerClass : ''}`}
      >
        <Clock3Icon className="size-3.5 shrink-0" aria-hidden />
        <span>
          {draft.durationSeconds !== null
            ? t('composer.params.durationShort', { n: draft.durationSeconds })
            : t('composer.params.duration')}
        </span>
        {staleDuration !== null && <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />}
      </DropdownMenuTrigger>
      <ComposerMenuContent
        side="top"
        sideOffset={10}
        align="end"
        className="w-[400px] p-4 shadow-2xl"
      >
        <p className="text-muted-foreground mb-4 text-xs font-medium">
          {t('composer.params.duration')}
        </p>
        {staleDuration !== null && (
          <div className="mb-3">
            <StaleRow value={t('composer.params.durationShort', { n: staleDuration })} />
          </div>
        )}
        <OptionStrip
          items={durations}
          isSelected={(duration) => duration === draft.durationSeconds}
          layout="h-9 text-[11px]"
          onSelect={(duration) => workbench.patchDraft({ durationSeconds: duration })}
          render={(duration) => t('composer.params.seconds', { n: duration })}
        />
      </ComposerMenuContent>
    </DropdownMenu>
  )
}

function Separator(): React.JSX.Element {
  return (
    <span className="text-muted-foreground/60" aria-hidden>
      |
    </span>
  )
}

// Option cells carry their own height and font size — the strip layouts give
// them, e.g. 'h-9 text-[13px]' or the vertical 'h-[52px] flex-col gap-2.5'.
function paramOptionClass(selected: boolean, layout: string): string {
  return (
    `${layout} flex items-center justify-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 ` +
    (selected
      ? 'bg-accent text-foreground font-medium'
      : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground')
  )
}

// One row of equal-width option cells driven by a manifest candidate list;
// `layout` carries the cell's height and font size, `render` its content.
function OptionStrip<T extends string | number>({
  items,
  isSelected,
  layout,
  onSelect,
  render
}: {
  readonly items: readonly T[]
  readonly isSelected: (item: T) => boolean
  readonly layout: string
  readonly onSelect: (item: T) => void
  readonly render: (item: T) => React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className="bg-accent/60 grid gap-1 rounded-xl p-1"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((item) => {
        const selected = isSelected(item)
        return (
          <button
            key={String(item)}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(item)}
            className={paramOptionClass(selected, layout)}
          >
            {render(item)}
          </button>
        )
      })}
    </div>
  )
}

// The ratio cell icon: a border box at the published ratio's real proportions
// (21:9 reads as a wide strip, 9:16 as a tall one). The params strip passes
// `diagonal` so every ratio previews at the same perceived size; without it
// the longest edge scales to `max` (the inline trigger). A missing or
// malformed ratio falls back to a neutral square so video and stale drafts
// keep an icon.
function RatioGlyph({
  ratio,
  max = 20,
  diagonal
}: {
  readonly ratio: string | null
  readonly max?: number
  readonly diagonal?: number
}): React.JSX.Element {
  const size =
    (ratio === null
      ? null
      : diagonal === undefined
        ? ratioGlyphSize(ratio, max)
        : ratioGlyphDiagonalSize(ratio, diagonal)) ??
    (diagonal === undefined
      ? { width: max * 0.7, height: max * 0.7 }
      : { width: diagonal / Math.SQRT2, height: diagonal / Math.SQRT2 })
  return (
    <span
      className="block shrink-0 rounded-[4px] border-[1.5px] border-current"
      style={{ width: size.width, height: size.height }}
      aria-hidden
    />
  )
}

function ParamGroup({
  label,
  children
}: {
  readonly label: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <p className="text-muted-foreground text-[11px]">{label}</p>
      {children}
    </div>
  )
}

function StaleRow({ value }: { readonly value: string }): React.JSX.Element {
  const { t } = useTranslation('creation')
  return (
    <div
      role="note"
      className="bg-warning/10 text-warning flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px]"
    >
      <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{value}</span>
      <span className="text-muted-foreground shrink-0">{t('composer.stale.badge')}</span>
    </div>
  )
}
