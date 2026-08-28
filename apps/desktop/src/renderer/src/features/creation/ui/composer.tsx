import { useTranslation } from 'react-i18next'
import {
  CheckIcon,
  ChevronDownIcon,
  ImageIcon,
  SendIcon,
  TriangleAlertIcon,
  VideoIcon
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '../../../components/ui/dropdown-menu'
import type { CapabilityMediaMode, CapabilityReason } from '../api/capability-manifest-http'
import {
  mediaCapability,
  modeCandidates,
  modelCandidates,
  type DraftMediaType
} from '../model/capability'
import type { CreationWorkbenchController } from '../model/use-workbench'
import { ReferenceDeck } from './reference-deck'

// Dynamic verdict vocabularies resolve through explicit key maps — the same
// shape the provider-connection surface uses for wire codes.

const reasonKeys = {
  production_readiness_pending: 'composer.unavailable.reasons.production_readiness_pending',
  not_configured: 'composer.unavailable.reasons.not_configured',
  checking: 'composer.unavailable.reasons.checking',
  credential_invalid: 'composer.unavailable.reasons.credential_invalid',
  credential_unavailable: 'composer.unavailable.reasons.credential_unavailable',
  connection_paused: 'composer.unavailable.reasons.connection_paused',
  model_unavailable: 'composer.unavailable.reasons.model_unavailable'
} as const

const actionKeys = {
  wait: 'composer.unavailable.actions.wait',
  await_release: 'composer.unavailable.actions.await_release',
  contact_admin: 'composer.unavailable.actions.contact_admin'
} as const

const modeKeys = {
  'text-to-image': 'composer.mode.text-to-image',
  'reference-image': 'composer.mode.reference-image',
  'text-to-video': 'composer.mode.text-to-video',
  'first-frame': 'composer.mode.first-frame',
  'first-last-frame': 'composer.mode.first-last-frame',
  'omni-reference': 'composer.mode.omni-reference'
} as const

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

  const triggerClass =
    'flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] outline-none transition-colors data-[state=open]:bg-accent'

  const staleTrigger = (stale: boolean): string =>
    stale
      ? 'border-warning/70 text-warning'
      : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted'

  const deckMaterials = workbench.materials

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
              materials={deckMaterials}
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
            triggerClass={`${triggerClass} ${staleTrigger(staleFields.has('mediaType'))}`}
          />
          {media !== null && (
            <ModelMenu
              workbench={workbench}
              triggerClass={`${triggerClass} ${staleTrigger(staleFields.has('model'))}`}
            />
          )}
          {media === 'video' && controls && (
            <ModeMenu
              workbench={workbench}
              triggerClass={`${triggerClass} ${staleTrigger(staleFields.has('mode'))}`}
            />
          )}
          {media !== null && controls && (
            <ParamsMenu workbench={workbench} triggerClass={triggerClass} />
          )}
          <div className="ml-auto flex items-center gap-2">
            <SaveStatus workbench={workbench} />
            <button
              type="button"
              disabled
              title={String(t('composer.submitPending'))}
              aria-label={String(t('composer.submit'))}
              aria-disabled="true"
              data-testid="composer-submit"
              className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-full"
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
  const { manifest, manifestStatus, draft } = workbench
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger data-testid="composer-media" className={triggerClass}>
        {draft.mediaType === 'video' ? (
          <VideoIcon className="size-3.5 text-cyan-600 dark:text-cyan-300" aria-hidden />
        ) : draft.mediaType === 'image' ? (
          <ImageIcon className="size-3.5 text-cyan-600 dark:text-cyan-300" aria-hidden />
        ) : null}
        <span className={draft.mediaType === null ? '' : 'text-cyan-600 dark:text-cyan-300'}>
          {label}
        </span>
        <ChevronDownIcon className="size-3 opacity-60" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-[180px]">
        {options.map(({ media, available }) => {
          const reason = manifest === null ? null : manifestImageVideoReason(manifest, media)
          return (
            <DropdownMenuItem
              key={media}
              disabled={available === false}
              onSelect={() => workbench.setMediaType(media)}
            >
              <span className="flex items-center gap-1.5">
                {available === false ? (
                  <TriangleAlertIcon className="text-warning size-3" aria-hidden />
                ) : draft.mediaType === media ? (
                  <CheckIcon className="size-3" aria-hidden />
                ) : null}
                {t(`composer.media.${media}`)}
                {reason !== null && (
                  <span className="text-muted-foreground">{t(reasonKeys[reason])}</span>
                )}
              </span>
            </DropdownMenuItem>
          )
        })}
        {manifestStatus === 'unavailable' && (
          <DropdownMenuLabel className="text-muted-foreground text-[10px]">
            {t('composer.manifestUnavailable')}
          </DropdownMenuLabel>
        )}
      </DropdownMenuContent>
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
        <span className="max-w-40 truncate">{draft.model ?? t('composer.model.label')}</span>
        {staleModel !== null && <TriangleAlertIcon className="text-warning size-3" aria-hidden />}
        <ChevronDownIcon className="size-3 opacity-60" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-[220px]">
        {staleModel !== null && <StaleRow value={staleModel} />}
        {candidates.map((model) => (
          <DropdownMenuItem key={model} onSelect={() => workbench.patchDraft({ model })}>
            <span className="flex items-center gap-1.5">
              {draft.model === model ? <CheckIcon className="size-3" aria-hidden /> : null}
              {model}
            </span>
          </DropdownMenuItem>
        ))}
        {candidates.length === 0 && staleModel === null && (
          <DropdownMenuLabel className="text-muted-foreground text-[10px]">
            {t('composer.manifestUnavailable')}
          </DropdownMenuLabel>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ModeMenu({
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
  const candidates = modeCandidates(manifest, media)
  const staleMode = staleFields.has('mode') ? draft.mode : null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger data-testid="composer-mode" className={triggerClass}>
        <span>
          {draft.mode !== null && draft.mode in modeKeys
            ? t(modeKeys[draft.mode as CapabilityMediaMode])
            : (draft.mode ?? t('composer.mode.label'))}
        </span>
        {staleMode !== null && <TriangleAlertIcon className="text-warning size-3" aria-hidden />}
        <ChevronDownIcon className="size-3 opacity-60" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-[160px]">
        {staleMode !== null && <StaleRow value={staleMode} />}
        {candidates.map((mode) => (
          <DropdownMenuItem key={mode} onSelect={() => workbench.setMode(mode)}>
            <span className="flex items-center gap-1.5">
              {draft.mode === mode ? <CheckIcon className="size-3" aria-hidden /> : null}
              {t(modeKeys[mode])}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ParamsMenu({
  workbench,
  triggerClass
}: {
  readonly workbench: CreationWorkbenchController
  readonly triggerClass: string
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const { draft, manifest, staleFields } = workbench
  const media = draft.mediaType
  const capability = media === null ? null : mediaCapability(manifest, media)
  if (media === null || capability === null || !capability.available) return <></>

  const ratios = capability.ratios ?? []
  const resolutions = capability.resolutions ?? []
  const quantities = capability.quantities ?? []
  const durations = capability.durations ?? []
  const staleRatio = staleFields.has('ratio') ? draft.ratio : null
  const staleResolution = staleFields.has('resolution') ? draft.resolution : null
  const staleQuantity = staleFields.has('quantity') ? draft.quantity : null
  const staleDuration = staleFields.has('durationSeconds') ? draft.durationSeconds : null

  const summary =
    media === 'image'
      ? [draft.ratio, draft.resolution, draft.quantity === null ? null : `×${draft.quantity}`]
      : [
          draft.resolution,
          draft.durationSeconds === null
            ? null
            : t('composer.params.seconds', { n: draft.durationSeconds })
        ]
  const staleParams =
    staleRatio !== null ||
    staleResolution !== null ||
    staleQuantity !== null ||
    staleDuration !== null
  const triggerWithStale =
    triggerClass +
    ' ' +
    (staleParams
      ? 'border-warning/70 text-warning'
      : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger data-testid="composer-params" className={triggerWithStale}>
        <span className="max-w-52 truncate">
          {summary.filter((entry) => entry !== null).join(' · ') || t('composer.params.label')}
        </span>
        {staleParams && <TriangleAlertIcon className="text-warning size-3" aria-hidden />}
        <ChevronDownIcon className="size-3 opacity-60" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-[320px] p-3">
        <div className="grid gap-3">
          {media === 'image' && (
            <ParamGroup label={t('composer.params.ratio')}>
              {staleRatio !== null && <StaleRow value={staleRatio} />}
              <div className="grid grid-cols-5 gap-1">
                {ratios.map((ratio) => (
                  <ParamOption
                    key={ratio}
                    selected={draft.ratio === ratio}
                    onSelect={() => workbench.patchDraft({ ratio })}
                    label={ratio}
                  />
                ))}
              </div>
            </ParamGroup>
          )}
          <ParamGroup label={t('composer.params.resolution')}>
            {staleResolution !== null && <StaleRow value={staleResolution} />}
            <div className="grid grid-cols-3 gap-1">
              {resolutions.map((resolution) => (
                <ParamOption
                  key={resolution}
                  selected={draft.resolution === resolution}
                  onSelect={() => workbench.patchDraft({ resolution })}
                  label={resolution}
                />
              ))}
            </div>
          </ParamGroup>
          {media === 'image' && (
            <ParamGroup label={t('composer.params.quantity')}>
              {staleQuantity !== null && <StaleRow value={String(staleQuantity)} />}
              <div className="grid grid-cols-4 gap-1">
                {quantities.map((quantity) => (
                  <ParamOption
                    key={quantity}
                    selected={draft.quantity === quantity}
                    onSelect={() => workbench.patchDraft({ quantity })}
                    label={String(quantity)}
                  />
                ))}
              </div>
            </ParamGroup>
          )}
          {media === 'video' && durations.length > 0 && (
            <ParamGroup label={t('composer.params.duration')}>
              {staleDuration !== null && <StaleRow value={`${staleDuration}s`} />}
              <div className="grid grid-cols-4 gap-1">
                {durations.map((duration) => (
                  <ParamOption
                    key={duration}
                    selected={draft.durationSeconds === duration}
                    onSelect={() => workbench.patchDraft({ durationSeconds: duration })}
                    label={t('composer.params.seconds', { n: duration })}
                  />
                ))}
              </div>
            </ParamGroup>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
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
      <p className="text-muted-foreground text-[10px] uppercase">{label}</p>
      {children}
    </div>
  )
}

function ParamOption({
  label,
  selected,
  onSelect
}: {
  readonly label: string
  readonly selected: boolean
  readonly onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={
        'rounded-md px-2 py-1.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 ' +
        (selected
          ? 'bg-accent text-accent-foreground font-medium'
          : 'bg-muted/60 text-muted-foreground hover:bg-muted')
      }
    >
      {label}
    </button>
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
