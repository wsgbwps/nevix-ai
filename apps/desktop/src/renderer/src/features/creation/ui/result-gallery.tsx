import { useLayoutEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkbenchGalleryHandle } from '../model/use-workbench'
import { useReadingAnchor } from './use-reading-anchor'
import { TaskCard } from './task-card'

/**
 * The borderless result gallery: tasks read old→new so the newest card sits
 * nearest the composer at the bottom. The server pages newest-first; the
 * reversal is display-only.
 */
export function ResultGallery({
  gallery,
  scrollerRef
}: {
  readonly gallery: WorkbenchGalleryHandle
  readonly scrollerRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const { tasks, dismissalSkipped } = gallery
  const orderedTasks = useMemo(() => [...tasks].reverse(), [tasks])
  // A failed list read keeps every loaded task and only adds the note.
  const staleNote = gallery.taskListStale ? (
    <p className="text-warning/80 text-xs" role="status" data-testid="task-list-stale">
      {t('gallery.listStale')}
    </p>
  ) : null
  // A deleted task's card is gone, so the results the deletion could not remove
  // are reported here instead (ADR-0022).
  const skippedNote =
    dismissalSkipped > 0 ? (
      <p
        className="text-muted-foreground text-xs"
        role="status"
        data-testid="task-dismissal-skipped"
      >
        {t('gallery.deleteSkipped', { count: dismissalSkipped })}
      </p>
    ) : null
  const { galleryRef, virtualizer, scrollMargin, remeasure } = useReadingAnchor({
    scrollerRef,
    taskIds: orderedTasks.map((task) => task.id)
  })
  // The note's mount/unmount above the gallery changes every card's margin, so
  // measure in that same commit (a ResizeObserver fires one observable frame
  // too late). A same-commit count change composes: the anchor hook's margin
  // effect re-measures on its own count dep, and a repeat measure no-ops.
  const taskHistory = gallery.taskHistory
  useLayoutEffect(() => {
    remeasure()
  }, [dismissalSkipped, remeasure, taskHistory.failed, taskHistory.hasMore, taskHistory.loading])

  if (tasks.length === 0) {
    return (
      <>
        {skippedNote}
        {staleNote ?? (
          <p className="text-muted-foreground text-xs" role="status">
            {t('workspace.generationPending')}
          </p>
        )}
      </>
    )
  }
  const virtualItems = virtualizer.getVirtualItems()
  return (
    <div
      ref={galleryRef}
      className="relative w-full"
      data-testid="result-gallery"
      data-total-count={tasks.length}
      style={{ height: virtualizer.getTotalSize() }}
    >
      {staleNote}
      {skippedNote}
      {virtualItems.map((virtualItem) => {
        const task = orderedTasks[virtualItem.index]
        return (
          <div
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            data-task-id={task.id}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${virtualItem.start - scrollMargin}px)` }}
          >
            <TaskCard gallery={gallery} task={task} />
          </div>
        )
      })}
    </div>
  )
}
