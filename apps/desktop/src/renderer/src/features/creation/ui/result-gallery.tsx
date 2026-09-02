import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BanIcon, DownloadIcon, RefreshCwIcon, RepeatIcon, TriangleAlertIcon } from 'lucide-react'
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
 * The four-column square-edged result gallery (issue #159, prototype
 * 6e465e8): every task renders its stable ordered slots inline with their
 * state, and the task-level actions — cancel, regenerate, retry only the
 * uncompleted slots — sit beneath the grid. States live inside the slots;
 * there is no separate banner to correlate with.
 */

const galleryGridClass = 'grid grid-cols-2 gap-2 md:grid-cols-4'

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
    <div className="flex flex-col gap-6" data-testid="result-gallery">
      {tasks.map((task) => (
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
  return (
    <section
      aria-label={String(t(statusKey(task.status)))}
      data-testid={`task-${task.id}`}
      className="border-border/70 rounded-none border p-3"
    >
      <div className="text-muted-foreground mb-2 flex items-center gap-2 text-[10px]">
        <span className="text-foreground/80 font-medium">{t(statusKey(task.status))}</span>
        <span>
          {mediaKeys[task.mediaType] && t(mediaKeys[task.mediaType])} ·{' '}
          {t('gallery.slotCount', { n: task.slotCount })}
        </span>
      </div>
      <div className={galleryGridClass}>
        {(detail?.slots ?? placeholderSlots(task.slotCount)).map((slot) => (
          <SlotCard
            key={slot.index}
            workbench={workbench}
            taskId={task.id}
            slot={slot}
            mediaType={task.mediaType}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        {!terminal && (
          <button
            type="button"
            data-testid={`task-cancel-${task.id}`}
            onClick={() => workbench.cancelTask(task.id)}
            className="text-muted-foreground border-border hover:bg-accent flex h-7 items-center gap-1 rounded-lg border px-2 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
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
            className="text-muted-foreground border-border hover:bg-accent flex h-7 items-center gap-1 rounded-lg border px-2 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 disabled:opacity-50"
          >
            <RefreshCwIcon className="size-3" aria-hidden />
            {t('gallery.actions.regenerate')}
          </button>
        )}
        {terminal &&
          !indeterminate &&
          task.status !== 'succeeded' &&
          task.status !== 'cancelled' &&
          !hasPolicyRejectedSlot(detail) && (
            <button
              type="button"
              data-testid={`task-retry-${task.id}`}
              onClick={() => workbench.retryTask(task.id)}
              className="text-muted-foreground border-border hover:bg-accent flex h-7 items-center gap-1 rounded-lg border px-2 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
            >
              <RepeatIcon className="size-3" aria-hidden />
              {t('gallery.actions.retryUncompleted')}
            </button>
          )}
        {terminal && indeterminate && (
          <button
            type="button"
            data-testid={`task-retry-indeterminate-${task.id}`}
            onClick={() => workbench.requestIndeterminateRedo(task.id)}
            className="text-muted-foreground border-border hover:bg-accent flex h-7 items-center gap-1 rounded-lg border px-2 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
          >
            <RepeatIcon className="size-3" aria-hidden />
            {t('gallery.actions.retryUncompleted')}
          </button>
        )}
      </div>
      {workbench.indeterminateTaskId === task.id && (
        <div
          role="alertdialog"
          aria-label={t('gallery.indeterminate.title')}
          data-testid={`indeterminate-confirm-${task.id}`}
          className="bg-warning/10 mt-2 rounded-lg p-2"
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

function SlotCard({
  workbench,
  taskId,
  slot,
  mediaType
}: {
  readonly workbench: CreationWorkbenchController
  readonly taskId: string
  readonly slot: GenerationSlotView
  readonly mediaType: 'image' | 'video'
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
      className="bg-accent/40 border-border/60 relative aspect-square overflow-hidden rounded-none border"
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
