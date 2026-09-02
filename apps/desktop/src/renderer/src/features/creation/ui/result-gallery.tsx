import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BanIcon,
  DownloadIcon,
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
  GenerationTaskDetail,
  GenerationTaskView,
  SlotFailureDiagnosticSource,
  SlotFailureReason,
  SlotResultView
} from '../api/generation-task-http'
import type { CreationWorkbenchController } from '../model/use-workbench'
import { modeKeys } from '../i18n/mode-keys'

// Dynamic verdict vocabularies resolve through explicit key maps — the same
// shape the composer uses for wire codes.
const statusKeys = {
  queued: 'gallery.status.queued',
  generating: 'gallery.status.generating',
  persisting: 'gallery.status.persisting',
  cancelling: 'gallery.status.cancelling',
  succeeded: 'gallery.status.succeeded',
  partially_succeeded: 'gallery.status.partially_succeeded',
  failed: 'gallery.status.failed',
  cancelled: 'gallery.status.cancelled',
  timed_out: 'gallery.status.timed_out',
  indeterminate: 'gallery.status.indeterminate'
} as const

const reasonKeys = {
  invalid_input: 'gallery.reasons.invalid_input',
  rights_confirmation_required: 'gallery.reasons.rights_confirmation_required',
  input_policy_rejected: 'gallery.reasons.input_policy_rejected',
  output_policy_rejected: 'gallery.reasons.output_policy_rejected',
  action_required: 'gallery.reasons.action_required',
  temporarily_unavailable: 'gallery.reasons.temporarily_unavailable',
  provider_route_unavailable: 'gallery.reasons.provider_route_unavailable',
  processing_indeterminate: 'gallery.reasons.processing_indeterminate',
  internal_error: 'gallery.reasons.internal_error'
} as const

function statusKey(status: string): (typeof statusKeys)[keyof typeof statusKeys] {
  return status in statusKeys ? statusKeys[status as keyof typeof statusKeys] : statusKeys.failed
}

function reasonKey(reason: SlotFailureReason): (typeof reasonKeys)[keyof typeof reasonKeys] {
  return reason in reasonKeys ? reasonKeys[reason] : reasonKeys.internal_error
}

const diagnosticSourceKeys = {
  provider: 'gallery.diagnostic.sources.provider',
  output_transfer: 'gallery.diagnostic.sources.output_transfer',
  storage: 'gallery.diagnostic.sources.storage',
  media_probe: 'gallery.diagnostic.sources.media_probe'
} as const

function diagnosticSourceKey(
  source: SlotFailureDiagnosticSource
): (typeof diagnosticSourceKeys)[keyof typeof diagnosticSourceKeys] {
  return diagnosticSourceKeys[source]
}

const mediaKeys = {
  image: 'composer.media.image',
  video: 'composer.media.video'
} as const

/**
 * The borderless result gallery: tasks read old→new so the newest card sits
 * nearest the composer at the bottom — the server pages tasks newest-first,
 * and the reversal is display-only. Every task renders three stacked blocks
 * (the prompt with its parameter row, the slot strip, the task actions), and
 * states live inside the slots; there is no separate banner to correlate
 * with.
 *
 * The prompt and parameters mirror the session's current draft: Generation
 * Tasks do not yet freeze a per-task specification snapshot on the wire
 * (contract extension tracked in #186), so every card shows the draft the
 * session holds right now.
 */

const galleryGridClass = 'grid grid-cols-2 gap-2 md:grid-cols-4'

// Quiet borderless affordances for the task's action row.
const quietButtonClass =
  'text-muted-foreground hover:bg-accent hover:text-foreground flex h-7 items-center gap-1 rounded-lg px-2 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50'

export function ResultGallery({
  workbench
}: {
  readonly workbench: CreationWorkbenchController
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const { tasks } = workbench
  if (tasks.length === 0) {
    return (
      <p className="text-muted-foreground text-xs" role="status">
        {t('workspace.generationPending')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-8" data-testid="result-gallery">
      {[...tasks].reverse().map((task) => (
        <TaskCard key={task.id} workbench={workbench} task={task} />
      ))}
    </div>
  )
}

function TaskCard({
  workbench,
  task
}: {
  readonly workbench: CreationWorkbenchController
  readonly task: GenerationTaskView
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const detail = workbench.taskDetails[task.id]
  const terminal = isTerminalTaskStatus(task.status)
  const indeterminate = task.terminalCause !== null
  const { draft } = workbench
  const retryUncompleted =
    terminal &&
    !indeterminate &&
    task.status !== 'succeeded' &&
    task.status !== 'cancelled' &&
    !hasPolicyRejectedSlot(detail)
  // The composer is a fixed surface that owns the live draft; re-editing a
  // task means editing that draft and regenerating.
  const focusComposerPrompt = (): void => {
    document.getElementById('composer-prompt')?.focus()
  }
  return (
    <section
      aria-label={String(t(statusKey(task.status)))}
      data-testid={`task-${task.id}`}
      className="animate-in fade-in slide-in-from-bottom-2 flex flex-col gap-2.5 duration-300"
    >
      <div className="flex flex-col gap-1">
        {draft.prompt.length > 0 && (
          <p className="text-foreground/80 line-clamp-3 text-xs leading-5">{draft.prompt}</p>
        )}
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-[10px]">
          <span className="text-foreground/70 font-medium">{t(statusKey(task.status))}</span>
          <span>
            {t(mediaKeys[task.mediaType])}
            {draft.model !== null && ` · ${draft.model}`}
          </span>
          {draft.ratio !== null && (
            <>
              <MetaSeparator />
              <span>{draft.ratio}</span>
            </>
          )}
          {draft.resolution !== null && (
            <>
              <MetaSeparator />
              <span>{draft.resolution}</span>
            </>
          )}
          <TaskDetailsMenu workbench={workbench} task={task} />
        </div>
      </div>
      <div className={galleryGridClass}>
        {(detail?.slots ?? placeholderSlots(task.slotCount)).map((slot) => (
          <SlotCard
            key={slot.index}
            workbench={workbench}
            taskId={task.id}
            slot={slot}
            mediaType={task.mediaType}
            fallbackRatio={draft.ratio}
          />
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          data-testid={`task-edit-${task.id}`}
          onClick={focusComposerPrompt}
          className={quietButtonClass}
        >
          <PencilLineIcon className="size-3" aria-hidden />
          {t('gallery.actions.reedit')}
        </button>
        {!terminal && (
          <button
            type="button"
            data-testid={`task-cancel-${task.id}`}
            onClick={() => workbench.cancelTask(task.id)}
            className={quietButtonClass}
          >
            <BanIcon className="size-3" aria-hidden />
            {t('gallery.actions.cancel')}
          </button>
        )}
        {terminal && (
          <button
            type="button"
            data-testid={`task-regenerate-${task.id}`}
            onClick={workbench.submit}
            disabled={workbench.submitDisabled}
            className={`${quietButtonClass} disabled:opacity-50`}
          >
            <RefreshCwIcon className="size-3" aria-hidden />
            {t('gallery.actions.regenerate')}
          </button>
        )}
        {(retryUncompleted || indeterminate) && (
          <DropdownMenu>
            <DropdownMenuTrigger
              data-testid={`task-more-${task.id}`}
              aria-label={String(t('gallery.actions.more'))}
              className={quietButtonClass}
            >
              <MoreHorizontalIcon className="size-3.5" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44 rounded-xl">
              {retryUncompleted && (
                <DropdownMenuItem
                  data-testid={`task-retry-${task.id}`}
                  className="cursor-pointer text-xs"
                  onSelect={() => workbench.retryTask(task.id)}
                >
                  <RepeatIcon className="size-3.5" aria-hidden />
                  {t('gallery.actions.retryUncompleted')}
                </DropdownMenuItem>
              )}
              {indeterminate && (
                <DropdownMenuItem
                  data-testid={`task-retry-indeterminate-${task.id}`}
                  className="cursor-pointer text-xs"
                  onSelect={() => workbench.requestIndeterminateRedo(task.id)}
                >
                  <RepeatIcon className="size-3.5" aria-hidden />
                  {t('gallery.actions.retryUncompleted')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {workbench.indeterminateTaskId === task.id && (
        <div
          role="alertdialog"
          aria-label={t('gallery.indeterminate.title')}
          data-testid={`indeterminate-confirm-${task.id}`}
          className="bg-warning/10 rounded-lg p-2"
        >
          <p className="text-warning flex items-start gap-1.5 text-[11px] leading-4">
            <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
            {t('gallery.indeterminate.body')}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-testid={`indeterminate-confirm-button-${task.id}`}
              onClick={() => workbench.confirmIndeterminateRedo(task.id)}
              className="text-warning border-warning/60 hover:bg-warning/10 h-7 rounded-lg border px-2 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
            >
              {t('gallery.indeterminate.confirm')}
            </button>
            <button
              type="button"
              onClick={workbench.dismissIndeterminate}
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

/**
 * The draft facts behind a task; replaced by the task's own frozen snapshot
 * once the contract extension in #186 lands.
 */
function TaskDetailsMenu({
  workbench,
  task
}: {
  readonly workbench: CreationWorkbenchController
  readonly task: GenerationTaskView
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const { draft } = workbench
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
        {draft.prompt.length > 0 && (
          <DetailRow label={t('gallery.details.prompt')}>
            <span className="line-clamp-6 whitespace-pre-wrap">{draft.prompt}</span>
          </DetailRow>
        )}
        {draft.mode !== null && (
          <DetailRow
            label={t('gallery.details.mode')}
            value={
              draft.mode in modeKeys
                ? String(t(modeKeys[draft.mode as keyof typeof modeKeys]))
                : draft.mode
            }
          />
        )}
        {draft.quantity !== null && (
          <DetailRow label={t('gallery.details.quantity')} value={String(draft.quantity)} />
        )}
        {draft.durationSeconds !== null && (
          <DetailRow
            label={t('gallery.details.duration')}
            value={String(t('composer.params.seconds', { n: draft.durationSeconds }))}
          />
        )}
        {draft.references.length > 0 && (
          <DetailRow
            label={t('gallery.details.references')}
            value={String(draft.references.length)}
          />
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

// Slot cells keep the verified result's intrinsic shape — the height scales
// with the image ratio instead of a fixed square, so one task's images align
// as an even strip. Unsettled slots borrow the draft's target ratio; with no
// ratio anywhere the cell falls back to square.
function slotAspectRatio(slot: GenerationSlotView, fallbackRatio: string | null): number {
  const { widthPx, heightPx } = slot.result ?? {}
  if (
    widthPx !== null &&
    widthPx !== undefined &&
    heightPx !== null &&
    heightPx !== undefined &&
    widthPx > 0 &&
    heightPx > 0
  ) {
    return widthPx / heightPx
  }
  const [width, height] = (fallbackRatio ?? '').split(':').map(Number)
  return width > 0 && height > 0 ? width / height : 1
}

function SlotCard({
  workbench,
  taskId,
  slot,
  mediaType,
  fallbackRatio
}: {
  readonly workbench: CreationWorkbenchController
  readonly taskId: string
  readonly slot: GenerationSlotView
  readonly mediaType: 'image' | 'video'
  readonly fallbackRatio: string | null
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const [url, setUrl] = useState<string | null>(null)
  const succeeded = slot.status === 'succeeded'

  // The verified output renders inside its slot; the blob rides the trusted
  // data plane like every other byte and is fetched exactly once.
  useEffect(() => {
    if (!succeeded) return
    let active = true
    void workbench
      .loadResultBlobUrl(taskId, slot.index)
      .then((blobUrl) => {
        if (active && blobUrl !== null) setUrl(blobUrl)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [mediaType, succeeded, slot.index, taskId, workbench])

  // The download reuses the already-verified bytes (or loads them on demand)
  // and names the file after its task slot.
  const download = (): void => {
    void workbench
      .loadResultBlobUrl(taskId, slot.index)
      .then((blobUrl) => {
        if (blobUrl === null) return
        const anchor = document.createElement('a')
        anchor.href = blobUrl
        anchor.download = downloadFilename(taskId, slot.index, mediaType, slot.result)
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      })
      .catch(() => undefined)
  }

  return (
    <div
      data-testid={`slot-${taskId}-${slot.index}`}
      data-slot-status={slot.status}
      role={succeeded ? undefined : 'status'}
      aria-label={String(t(statusKey(slot.status)))}
      style={{ aspectRatio: String(slotAspectRatio(slot, fallbackRatio)) }}
      className="bg-foreground/[0.04] relative overflow-hidden rounded-lg"
    >
      {succeeded && url !== null ? (
        mediaType === 'image' ? (
          <img src={url} alt={t('gallery.resultAlt')} className="size-full object-cover" />
        ) : (
          <video src={url} controls className="size-full object-cover" />
        )
      ) : (
        <span className="absolute inset-0 flex overflow-y-auto p-2">
          <span className="text-muted-foreground my-auto w-full text-center text-[10px] leading-4">
            {t(statusKey(slot.status))}
            {slot.failureReason !== null && (
              <span className="block">{t(reasonKey(slot.failureReason))}</span>
            )}
            {slot.failureDiagnostic != null && (
              <span
                className="border-border/70 mt-1 block border-t pt-1 text-left break-words"
                data-testid={`slot-diagnostic-${taskId}-${slot.index}`}
              >
                <span className="block font-medium">
                  {t(diagnosticSourceKey(slot.failureDiagnostic.source))}
                </span>
                <span className="block font-mono">
                  {slot.failureDiagnostic.code}
                  {slot.failureDiagnostic.providerType !== null
                    ? ` · ${slot.failureDiagnostic.providerType}`
                    : ''}
                  {slot.failureDiagnostic.httpStatus !== null
                    ? ` · HTTP ${slot.failureDiagnostic.httpStatus}`
                    : ''}
                </span>
                <span className="block">{slot.failureDiagnostic.message}</span>
                {slot.failureDiagnostic.requestId !== null && (
                  <span className="block font-mono">
                    {t('gallery.diagnostic.requestId')}: {slot.failureDiagnostic.requestId}
                  </span>
                )}
              </span>
            )}
          </span>
        </span>
      )}
      {succeeded && (
        <button
          type="button"
          data-testid={`slot-download-${taskId}-${slot.index}`}
          aria-label={String(t('gallery.actions.download'))}
          title={downloadFilename(taskId, slot.index, mediaType, slot.result)}
          onClick={download}
          className="absolute right-1 bottom-1 z-10 grid size-6 place-items-center rounded-md border border-white/25 bg-black/50 text-white outline-none hover:bg-black/65 focus-visible:ring-2 focus-visible:ring-sky-400/70"
        >
          <DownloadIcon className="size-3" aria-hidden />
        </button>
      )}
    </div>
  )
}

// Downloads keep the provider's original format: the extension follows the
// verified result's mime type (the vendor commonly returns JPEG), never a
// fixed png — the bytes themselves already pass through unmodified.
const resultExtensions: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4'
}

function downloadFilename(
  taskId: string,
  index: number,
  mediaType: 'image' | 'video',
  result: SlotResultView | null
): string {
  const extension =
    (result !== null ? resultExtensions[result.mimeType] : undefined) ??
    (mediaType === 'video' ? 'mp4' : 'png')
  return `nevix-${taskId.slice(0, 8)}-${index + 1}.${extension}`
}

export type { SlotFailureReason }
