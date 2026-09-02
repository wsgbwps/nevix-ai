import { useTranslation } from 'react-i18next'
import {
  BoxIcon,
  CheckIcon,
  ChevronDownIcon,
  Clock3Icon,
  ImageIcon,
  Link2Icon,
  SendIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  TriangleAlertIcon,
  VideoIcon
} from 'lucide-react'
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
import { ratioGlyphSize } from './ratio-glyph'
import { ReferenceDeck } from './reference-deck'

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

/**
 * The fixed bottom Composer (issue #177, prototype 6e465e8): prompt text
 * area, the inline reference deck, and the capability controls expanding
 * upward from the bottom row. Every candidate comes from the Capability
 * Manifest; draft values the manifest removed stay displayed with a stable
 * stale marker and are never rewritten. This slice creates no Generation
 * Task — the submit affordance stays disabled rather than faking success.
 */
export function CreationComposer({
  workbench
}: {
  readonly workbench: CreationWorkbenchController
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const { draft, manifest, manifestStatus, staleFields } = workbench

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
      className="absolute right-6 bottom-5 left-6 z-20 mx-auto max-w-[760px]"
      data-testid="composer"
    >
      <div className="bg-card rounded-[22px] border p-3 shadow-2xl">
        {unavailableLine !== null && (
          <p
            role="status"
            data-testid="composer-unavailable"
            className="text-warning mb-2 text-[11px]"
          >
            {unavailableLine}
          </p>
        )}
        <div className="flex min-h-16 items-start gap-3">
          <div className="min-w-0 shrink">
            <ReferenceDeck
              bindings={draft.references}
              materials={workbench.materials}
              thumbnails={workbench.thumbnails}
              cap={workbench.deckCap}
              allowedKinds={workbench.allowedKinds}
              onAdd={workbench.addMaterial}
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
          </div>
          <div className="min-w-0 flex-1">
            <label htmlFor="composer-prompt" className="sr-only">
              {t('composer.promptLabel')}
            </label>
            <textarea
              id="composer-prompt"
              data-testid="composer-prompt"
              value={draft.prompt}
              maxLength={promptCap}
              placeholder={
                draft.references.length > 0
                  ? String(t('composer.promptPlaceholderWithRefs'))
                  : String(t('composer.promptPlaceholder'))
              }
              onChange={(event) => workbench.patchDraft({ prompt: event.target.value })}
              className="placeholder:text-muted-foreground/70 text-foreground min-h-16 w-full resize-none bg-transparent px-1 py-1 text-xs leading-5 outline-none"
            />
          </div>
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1.5 border-t pt-2">
          <MediaMenu
            workbench={workbench}
            triggerClass={`${controlClass} ${draft.mediaType !== null && !staleFields.has('mediaType') ? 'text-cyan-600 dark:text-cyan-300' : ''} ${staleFields.has('mediaType') ? staleTriggerClass : ''}`}
          />
          {media !== null && <ModelMenu workbench={workbench} triggerClass={controlClass} />}
          {media === 'video' && controls && <ModeMenu workbench={workbench} />}
          {media !== null && controls && <ParamsMenu workbench={workbench} />}
          {media === 'video' && controls && <DurationMenu workbench={workbench} />}
          <div className="ml-auto flex items-center gap-2">
            <SaveStatus workbench={workbench} />
            <button
              type="button"
              disabled={workbench.submitDisabled}
              title={
                workbench.submitBlockedReason === 'stale'
                  ? String(t('composer.stale.badge'))
                  : workbench.submitBlockedReason === 'unavailable'
                    ? String(t('composer.unavailable.template', { reason: '', action: '' }))
                    : String(t('composer.submit'))
              }
              aria-label={String(t('composer.submit'))}
              aria-disabled={workbench.submitDisabled}
              data-testid="composer-submit"
              onClick={workbench.submit}
              className={
                'flex size-8 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 ' +
                (workbench.submitDisabled
                  ? 'bg-accent text-muted-foreground'
                  : 'bg-cyan-600 text-white hover:bg-cyan-500 dark:bg-cyan-500 dark:hover:bg-cyan-400')
              }
            >
              <SendIcon className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      </div>
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
                layout="h-[52px] flex-col gap-1"
                onSelect={(ratio) => workbench.patchDraft({ ratio })}
                render={(ratio) => (
                  <>
                    <RatioGlyph ratio={ratio} />
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
// them, e.g. 'h-9 text-[13px]' or the vertical 'h-[52px] flex-col gap-1'.
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
// (21:9 reads as a wide strip, 9:16 as a tall one). A missing or malformed
// ratio falls back to a neutral square so video and stale drafts keep an icon.
function RatioGlyph({
  ratio,
  max = 20
}: {
  readonly ratio: string | null
  readonly max?: number
}): React.JSX.Element {
  const size = (ratio === null ? null : ratioGlyphSize(ratio, max)) ?? {
    width: max * 0.7,
    height: max * 0.7
  }
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

function SaveStatus({
  workbench
}: {
  readonly workbench: CreationWorkbenchController
}): React.JSX.Element | null {
  const { t } = useTranslation('creation')
  if (workbench.saveStatus === 'idle') return null
  if (workbench.saveStatus === 'failed') {
    return (
      <button
        type="button"
        data-testid="composer-save"
        onClick={workbench.retrySave}
        className="text-destructive flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
      >
        <TriangleAlertIcon className="size-3" aria-hidden />
        {t('composer.save.failed')}
      </button>
    )
  }
  return (
    <span
      role="status"
      data-testid="composer-save"
      className="text-muted-foreground px-1.5 text-[10px]"
    >
      {workbench.saveStatus === 'saving' ? t('composer.save.saving') : t('composer.save.saved')}
    </span>
  )
}
