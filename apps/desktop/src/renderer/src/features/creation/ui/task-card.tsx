import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BanIcon,
  InfoIcon,
  MoreHorizontalIcon,
  PencilLineIcon,
  RefreshCwIcon,
  RepeatIcon,
  TriangleAlertIcon
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../../../components/ui/dropdown-menu'
import { isTerminalTaskStatus } from '../api/generation-task-http'
import type {
  GenerationSlotView,
  GenerationSpecificationReferenceView,
  GenerationSpecificationView,
  GenerationTaskDetail,
  GenerationTaskView
} from '../api/generation-task-http'
import type { ReferenceMaterialView } from '../api/go-creation-http'
import type { MaterialThumbnailState, WorkbenchGalleryHandle } from '../model/use-workbench'
import { modeKeys } from '../i18n/mode-keys'
import { statusKey } from '../i18n/gallery-keys'
import { SlotCard } from './slot-card'

const mediaKeys = {
  image: 'composer.media.image',
  video: 'composer.media.video'
} as const

// Reference kinds resolve through the deck's kind vocabulary so a card's
// glyph speaks the same words as the composer's pile.
const referenceKindKeys = {
  image: 'composer.deck.kind.image',
  video: 'composer.deck.kind.video',
  audio: 'composer.deck.kind.audio'
} as const

const roleKeys = {
  reference: 'gallery.role.reference',
  first_frame: 'gallery.role.firstFrame',
  last_frame: 'gallery.role.lastFrame',
  omni: 'gallery.role.omni'
} as const

const galleryGridClass = 'grid grid-cols-2 gap-2 md:grid-cols-4'

// Task action chips carry a persistent subtle fill so consecutive task cards
// read as separate groups.
const quietButtonClass =
  'text-muted-foreground bg-foreground/[0.06] hover:bg-accent hover:text-foreground flex h-8 items-center gap-1 rounded-md px-2.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50'

/**
 * Each card reads the prompt and parameters from the task's own frozen
 * Generation Specification — the detail's copy once it arrives, otherwise the
 * list summary's task snapshot — never the session draft, which may have
 * moved on.
 */
export function TaskCard({
  gallery,
  task
}: {
  readonly gallery: WorkbenchGalleryHandle
  readonly task: GenerationTaskView
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const detail = gallery.taskDetails[task.id]
  const snapshot = detail?.task ?? task
  const spec = detail?.specification ?? task.snapshot ?? null
  const terminal = isTerminalTaskStatus(snapshot.status)
  const indeterminate = snapshot.terminalCause !== null
  const retryUncompleted =
    terminal &&
    !indeterminate &&
    snapshot.status !== 'succeeded' &&
    snapshot.status !== 'cancelled' &&
    !hasPolicyRejectedSlot(detail)
  // The composer is a fixed surface that owns the live draft; re-editing a
  // task means editing that draft and regenerating.
  const focusComposerPrompt = (): void => {
    document.getElementById('composer-prompt')?.focus()
  }
  return (
    <section
      aria-label={String(t(statusKey(snapshot.status)))}
      data-testid={`task-${snapshot.id}`}
      className="flex flex-col gap-2.5"
    >
      <div className="flex items-start gap-2.5">
        {spec !== null && spec.references.length > 0 && (
          <TaskReferencePile
            taskId={snapshot.id}
            references={spec.references}
            materials={gallery.materials}
            thumbnails={gallery.thumbnails}
            thumbnailStates={gallery.thumbnailStates}
            onRetainThumbnail={gallery.retainMaterialThumbnail}
            onRequestThumbnail={gallery.requestMaterialThumbnail}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {spec !== null && spec.prompt.length > 0 && (
            <div className="group/prompt relative">
              <p className="text-foreground/80 line-clamp-2 text-xs leading-5">{spec.prompt}</p>
              {/* Hover expansion overlays the card without reflowing it; the
                  clone stays a wrapper descendant, so wrapper:hover — not the
                  clone's own hover — holds it open and it cannot flicker. */}
              <p
                aria-hidden
                className="text-foreground/80 bg-background invisible absolute inset-x-0 top-0 z-10 pb-1 text-xs leading-5 group-hover/prompt:visible"
              >
                {spec.prompt}
              </p>
            </div>
          )}
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-[10px]">
            <span className="text-foreground/70 font-medium">{t(statusKey(snapshot.status))}</span>
            {gallery.taskDetailStaleIds.has(snapshot.id) && (
              // This task's latest detail read failed; the card keeps its
              // last consistent copy and says so.
              <span className="text-warning/80" data-testid={`task-detail-stale-${snapshot.id}`}>
                {t('gallery.detailStale')}
              </span>
            )}
            <span>
              {t(mediaKeys[snapshot.mediaType])}
              {spec !== null && ` · ${spec.model}`}
            </span>
            {spec?.ratio != null && (
              <>
                <MetaSeparator />
                <span>{spec.ratio}</span>
              </>
            )}
            {spec?.resolution != null && (
              <>
                <MetaSeparator />
                <span>{spec.resolution}</span>
              </>
            )}
            <TaskDetailsMenu task={snapshot} spec={spec} />
          </div>
        </div>
      </div>
      <div className={galleryGridClass}>
        {(detail?.slots ?? placeholderSlots(snapshot.slotCount)).map((slot) => (
          <SlotCard
            key={slot.index}
            acquireResultBlobUrl={gallery.acquireResultBlobUrl}
            taskId={snapshot.id}
            slot={slot}
            mediaType={snapshot.mediaType}
            fallbackRatio={spec?.ratio ?? null}
          />
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          data-testid={`task-edit-${snapshot.id}`}
          onClick={focusComposerPrompt}
          className={quietButtonClass}
        >
          <PencilLineIcon className="size-3.5" aria-hidden />
          {t('gallery.actions.reedit')}
        </button>
        {!terminal && (
          <button
            type="button"
            data-testid={`task-cancel-${snapshot.id}`}
            onClick={() => gallery.cancelTask(snapshot.id)}
            className={quietButtonClass}
          >
            <BanIcon className="size-3.5" aria-hidden />
            {t('gallery.actions.cancel')}
          </button>
        )}
        {terminal && (
          <button
            type="button"
            data-testid={`task-regenerate-${snapshot.id}`}
            onClick={gallery.submit}
            disabled={gallery.submitDisabled}
            className={`${quietButtonClass} disabled:opacity-50`}
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
            {t('gallery.actions.regenerate')}
          </button>
        )}
        {(retryUncompleted || indeterminate) && (
          <DropdownMenu>
            <DropdownMenuTrigger
              data-testid={`task-more-${snapshot.id}`}
              aria-label={String(t('gallery.actions.more'))}
              className={quietButtonClass}
            >
              <MoreHorizontalIcon className="size-4" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44 rounded-xl">
              {retryUncompleted && (
                <DropdownMenuItem
                  data-testid={`task-retry-${snapshot.id}`}
                  className="cursor-pointer text-xs"
                  onSelect={() => gallery.retryTask(snapshot.id)}
                >
                  <RepeatIcon className="size-3.5" aria-hidden />
                  {t('gallery.actions.retryUncompleted')}
                </DropdownMenuItem>
              )}
              {indeterminate && (
                <DropdownMenuItem
                  data-testid={`task-retry-indeterminate-${snapshot.id}`}
                  className="cursor-pointer text-xs"
                  onSelect={() => gallery.requestIndeterminateRedo(snapshot.id)}
                >
                  <RepeatIcon className="size-3.5" aria-hidden />
                  {t('gallery.actions.retryUncompleted')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {gallery.indeterminateTaskId === snapshot.id && (
        <div
          role="alertdialog"
          aria-label={t('gallery.indeterminate.title')}
          data-testid={`indeterminate-confirm-${snapshot.id}`}
          className="bg-warning/10 rounded-lg p-2"
        >
          <p className="text-warning flex items-start gap-1.5 text-[11px] leading-4">
            <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
            {t('gallery.indeterminate.body')}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-testid={`indeterminate-confirm-button-${snapshot.id}`}
              onClick={() => gallery.confirmIndeterminateRedo(snapshot.id)}
              className="text-warning border-warning/60 hover:bg-warning/10 h-7 rounded-lg border px-2 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
            >
              {t('gallery.indeterminate.confirm')}
            </button>
            <button
              type="button"
              onClick={gallery.dismissIndeterminate}
              className="text-muted-foreground border-border hover:bg-accent h-7 rounded-lg border px-2 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
            >
              {t('gallery.indeterminate.cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function MetaSeparator(): React.JSX.Element {
  return (
    <span className="text-muted-foreground/50" aria-hidden>
      |
    </span>
  )
}

// The card's reference pile replicates the deck's fan in a static, read-only
// form (Reference Material, CONTEXT.md, covers the frozen-identity boundary).
// The pitch compresses so any frozen reference count stays inside the header
// row.
const fanRotations = [-5, 3, -3, 4, -4, 2.5]
const pileShifts = [0, -1.5, 1.5]
const pileCardWidth = 34
const pileCardHeight = 44
const pileMaxWidth = 104

function TaskReferencePile({
  taskId,
  references,
  materials,
  thumbnails,
  thumbnailStates,
  onRetainThumbnail,
  onRequestThumbnail
}: {
  readonly taskId: string
  readonly references: readonly GenerationSpecificationReferenceView[]
  readonly materials: readonly ReferenceMaterialView[]
  readonly thumbnails: Readonly<Record<string, string>>
  readonly thumbnailStates: Readonly<Record<string, MaterialThumbnailState>>
  readonly onRetainThumbnail: (materialId: string) => () => void
  readonly onRequestThumbnail: (materialId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const byId = useMemo(
    () => new Map(materials.map((material) => [material.id, material] as const)),
    [materials]
  )
  const thumbnailMaterialIdsKey = JSON.stringify(
    [
      ...new Set(
        references.flatMap((reference) => {
          const material = byId.get(reference.materialId)
          return material?.kind === 'image' ? [material.id] : []
        })
      )
    ].sort()
  )
  // Task refreshes rebuild equivalent frozen-reference arrays. Keying the
  // lease by ID content prevents each poll from revoking and re-reading it.
  const thumbnailMaterialIds = useMemo<readonly string[]>(
    () => JSON.parse(thumbnailMaterialIdsKey) as string[],
    [thumbnailMaterialIdsKey]
  )
  useEffect(() => {
    const releases = thumbnailMaterialIds.map(onRetainThumbnail)
    return () => {
      for (const release of releases) release()
    }
  }, [onRetainThumbnail, thumbnailMaterialIds])
  const pitch =
    references.length > 1
      ? Math.min(16, (pileMaxWidth - pileCardWidth) / (references.length - 1))
      : 0
  return (
    <div
      role="group"
      aria-label={String(t('gallery.references.pile', { n: references.length }))}
      data-testid={`task-references-${taskId}`}
      className="relative shrink-0 self-start"
      onMouseEnter={() => {
        for (const reference of references) {
          const material = byId.get(reference.materialId)
          if (material?.kind === 'image' && thumbnails[material.id] === undefined) {
            onRequestThumbnail(material.id)
          }
        }
      }}
      style={{
        width: pileCardWidth + pitch * (references.length - 1),
        height: pileCardHeight
      }}
    >
      {references.map((reference, position) => {
        const material = byId.get(reference.materialId)
        // Unknown frozen roles fall back to their raw wire value, like the
        // details menu's modes do.
        const role =
          reference.role in roleKeys
            ? String(t(roleKeys[reference.role as keyof typeof roleKeys]))
            : reference.role
        const title = material === undefined ? role : `${material.fileName} · ${role}`
        return (
          <div
            key={position}
            title={title}
            data-thumbnail-state={
              material?.kind === 'image'
                ? (thumbnailStates[reference.materialId] ?? 'unloaded')
                : undefined
            }
            className="border-foreground/20 bg-muted absolute top-0 overflow-hidden rounded-[5px] border shadow-sm"
            style={{
              left: position * pitch,
              width: pileCardWidth,
              height: pileCardHeight,
              zIndex: position,
              transform: `translateY(${pileShifts[position % pileShifts.length]}px) rotate(${fanRotations[position % fanRotations.length]}deg)`
            }}
          >
            {thumbnails[reference.materialId] !== undefined ? (
              <img
                src={thumbnails[reference.materialId]}
                alt=""
                className="size-full object-cover"
              />
            ) : (
              <span className="text-muted-foreground grid size-full place-content-center justify-items-center gap-0.5 text-[10px] uppercase">
                <span>{String(t(referenceKindKeys[reference.kind]))}</span>
                {material?.kind === 'image' &&
                  thumbnailStates[reference.materialId] === 'loading' && (
                    <span className="text-[8px] normal-case" role="status">
                      {t('composer.deck.thumbnailLoading')}
                    </span>
                  )}
                {material?.kind === 'image' &&
                  thumbnailStates[reference.materialId] === 'failed' && (
                    <span className="text-[8px] normal-case" role="alert">
                      {t('composer.deck.thumbnailFailed')}
                    </span>
                  )}
              </span>
            )}
            {material?.kind === 'image' && thumbnailStates[reference.materialId] === 'failed' && (
              <button
                type="button"
                aria-label={String(t('composer.deck.thumbnailRetry', { name: material.fileName }))}
                onClick={() => onRequestThumbnail(material.id)}
                className="bg-card/90 text-muted-foreground hover:text-foreground absolute right-0 bottom-0 z-10 grid size-4 place-items-center rounded-tl-sm outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
              >
                <RefreshCwIcon className="size-2.5" aria-hidden />
              </button>
            )}
          </div>
        )
      })}
      {/* The quote badge marks the pile as task references; the glyph is an
          inline solid quote because lucide's stroked quote has a different
          silhouette than the design's serif opening quotes. */}
      <div className="absolute -bottom-1 -left-1 z-10 grid size-5 place-items-center rounded-full border border-[#30333c] bg-[#22252b] text-[#41484f]">
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-2.5" aria-hidden>
          <path d="M8 4.2C7.3 6.9 6.9 8.6 7.2 10.2A4.9 4.9 0 1 1 2.6 11.9C4.1 9.2 6.3 6.3 8 4.2Z" />
          <path
            d="M8 4.2C7.3 6.9 6.9 8.6 7.2 10.2A4.9 4.9 0 1 1 2.6 11.9C4.1 9.2 6.3 6.3 8 4.2Z"
            transform="translate(11.3 0)"
          />
        </svg>
      </div>
    </div>
  )
}

/** The frozen-specification facts behind a task; with neither a detail
 * specification nor a list snapshot, only the task's own identity rows show. */
function TaskDetailsMenu({
  task,
  spec
}: {
  readonly task: GenerationTaskView
  readonly spec: GenerationSpecificationView | null
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const created = new Date(task.createdAt)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid={`task-details-${task.id}`}
        className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-6 items-center gap-1 rounded-lg px-1.5 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
      >
        {t('gallery.details.label')}
        <InfoIcon className="size-3" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 rounded-xl p-2">
        {spec !== null && (
          <>
            {spec.prompt.length > 0 && (
              <DetailRow label={t('gallery.details.prompt')}>
                <span className="line-clamp-6 whitespace-pre-wrap">{spec.prompt}</span>
              </DetailRow>
            )}
            <DetailRow
              label={t('gallery.details.mode')}
              value={
                spec.mode in modeKeys
                  ? String(t(modeKeys[spec.mode as keyof typeof modeKeys]))
                  : spec.mode
              }
            />
            <DetailRow label={t('gallery.details.quantity')} value={String(spec.quantity)} />
            {spec.durationSeconds !== null && (
              <DetailRow
                label={t('gallery.details.duration')}
                value={String(t('composer.params.seconds', { n: spec.durationSeconds }))}
              />
            )}
            {spec.references.length > 0 && (
              <DetailRow
                label={t('gallery.details.references')}
                value={String(spec.references.length)}
              />
            )}
          </>
        )}
        <DetailRow label={t('gallery.details.task')}>
          <span className="font-mono">{task.id}</span>
        </DetailRow>
        {!Number.isNaN(created.getTime()) && (
          <DetailRow label={t('gallery.details.createdAt')} value={created.toLocaleString()} />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DetailRow({
  label,
  value,
  children
}: {
  readonly label: string
  readonly value?: string
  readonly children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 px-1 py-0.5 text-[11px]">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-foreground/80 min-w-0 text-right break-words">{children ?? value}</span>
    </div>
  )
}

function placeholderSlots(count: number): GenerationSlotView[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    status: 'queued',
    failureReason: null,
    result: null
  }))
}

// A policy-rejected slot forbids the quick "retry uncompleted" affordance:
// the retry re-runs the frozen specification verbatim, so identical input or
// output content would be rejected again (spec #150 安全拒绝). Editing the
// draft and regenerating stays available.
function hasPolicyRejectedSlot(detail: GenerationTaskDetail | undefined): boolean {
  return (
    detail?.slots.some(
      (slot) =>
        slot.failureReason === 'input_policy_rejected' ||
        slot.failureReason === 'output_policy_rejected'
    ) ?? false
  )
}
