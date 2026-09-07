import { useLayoutEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkbenchGalleryHandle } from '../model/use-workbench'
import { useReadingAnchor } from './use-reading-anchor'
import { TaskCard } from './task-card'

/**
 * The borderless result gallery: tasks read old→new so the newest card sits
 * nearest the composer at the bottom — the server pages tasks newest-first,
 * and the reversal is display-only.
 */
export function ResultGallery({
  gallery,
  scrollerRef
}: {
  readonly gallery: WorkbenchGalleryHandle
  readonly scrollerRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const { t } = useTranslation('creation')
  const { tasks } = gallery
  const orderedTasks = useMemo(() => [...tasks].reverse(), [tasks])
  // A failed list read keeps every loaded task and only adds the note.
  const staleNote = gallery.taskListStale ? (
    <p className="text-warning/80 text-xs" role="status" data-testid="task-list-stale">
      {t('gallery.listStale')}
    </p>
  ) : null
  const { galleryRef, virtualizer, scrollMargin, remeasure } = useReadingAnchor({
    scrollerRef,
    taskIds: orderedTasks.map((task) => task.id)
  })
  // The history note's mount/unmount changes the layout above the gallery;
  // measure in that same commit (a ResizeObserver fires one observable frame
  // too late); a same-commit count change composes — the anchor hook's
  // margin effect re-measures on its own count dep, and a repeat measure
  // no-ops.
  const taskHistory = gallery.taskHistory
  useLayoutEffect(() => {
    remeasure()
  }, [remeasure, taskHistory.failed, taskHistory.hasMore, taskHistory.loading])

  if (tasks.length === 0) {
    return (
      staleNote ?? (
        <p className="text-muted-foreground text-xs" role="status">
          {t('workspace.generationPending')}
        </p>
      )
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
