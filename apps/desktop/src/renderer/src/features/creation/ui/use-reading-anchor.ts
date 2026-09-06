import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ReactVirtualizer } from '@tanstack/react-virtual'

/**
 * The gallery's Reading Anchor engine (CONTEXT.md, "Reading Anchor").
 * Contract: the caller renders one row per task id inside the element it
 * assigns galleryRef, each row carrying data-task-id — the engine locates
 * rows through that attribute.
 */
export function useReadingAnchor({
  scrollerRef,
  taskIds
}: {
  readonly scrollerRef: React.RefObject<HTMLDivElement | null>
  readonly taskIds: readonly string[]
}): {
  readonly galleryRef: React.RefObject<HTMLDivElement | null>
  readonly virtualizer: ReactVirtualizer<HTMLDivElement, Element>
  readonly scrollMargin: number
  readonly remeasure: () => void
} {
  const galleryActive = taskIds.length > 0
  const galleryRef = useRef<HTMLDivElement | null>(null)
  const readingAnchorRef = useRef<{ readonly taskId: string; readonly offset: number } | null>(null)
  const restoreReadingAnchorRef = useRef<
    | ((anchor: { readonly taskId: string; readonly offset: number }, immediate: boolean) => void)
    | null
  >(null)
  const previousTaskCountRef = useRef(taskIds.length)
  const [scrollMargin, setScrollMargin] = useState(0)
  // TanStack Virtual intentionally owns mutable measurement functions; the
  // React compiler excludes this component instead of memoizing stale ones.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: taskIds.length,
    getScrollElement: () => scrollerRef.current,
    getItemKey: (index) => taskIds[index] ?? index,
    estimateSize: () => 320,
    gap: 40,
    overscan: 3,
    scrollMargin,
    anchorTo: 'end',
    useAnimationFrameWithResizeObserver: true
  })

  useLayoutEffect(() => {
    // Creation treats the currently read viewport as the anchor even just
    // after an upward scroll. Compensate remeasured cards wholly above it;
    // TanStack's default intentionally skips that case while scrolling back.
    const adjust: NonNullable<typeof virtualizer.shouldAdjustScrollPositionOnItemSizeChange> = (
      item,
      _delta,
      instance
    ) => {
      const offset = (instance.scrollOffset ?? 0) + instance.scrollAdjustments
      return instance.itemSizeCache.has(item.key)
        ? item.start + item.size <= offset
        : item.start < offset
    }
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = adjust
    return () => {
      if (virtualizer.shouldAdjustScrollPositionOnItemSizeChange === adjust) {
        virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined
      }
    }
  }, [virtualizer])

  // Width changes can invalidate every measured card at once. Keep the
  // first intersecting task and its viewport offset until the new responsive
  // measurements settle; this is the user-facing reading anchor, independent
  // of which estimates the virtualizer replaces underneath it.
  useLayoutEffect(() => {
    const gallery = galleryRef.current
    const scroller = scrollerRef.current
    if (gallery === null || scroller === null) return
    let width = scroller.clientWidth
    let height = gallery.getBoundingClientRect().height
    let captureFrame: number | null = null
    let restoreFrame: number | null = null
    let restoring = false
    // A restore's own scrollTop write returns as a scroll event; the written
    // offset separates that echo from a reader's scroll, which must win.
    let restoreWrite: number | null = null

    const taskNode = (taskId: string): HTMLElement | null =>
      [...gallery.querySelectorAll<HTMLElement>('[data-task-id]')].find(
        (candidate) => candidate.dataset.taskId === taskId
      ) ?? null

    const capture = (): void => {
      if (restoring) return
      const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      if (distanceFromBottom <= 2) {
        readingAnchorRef.current = null
        return
      }
      const viewport = scroller.getBoundingClientRect()
      const node = [...gallery.querySelectorAll<HTMLElement>('[data-task-id]')].find(
        (candidate) => {
          const rect = candidate.getBoundingClientRect()
          return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1
        }
      )
      readingAnchorRef.current =
        node === undefined
          ? null
          : {
              taskId: node.dataset.taskId ?? '',
              offset: node.getBoundingClientRect().top - viewport.top
            }
    }

    const scheduleCapture = (): void => {
      if (restoring || captureFrame !== null) return
      captureFrame = requestAnimationFrame(() => {
        captureFrame = null
        capture()
      })
    }

    const correctToward = (saved: NonNullable<typeof readingAnchorRef.current>): boolean => {
      const node = taskNode(saved.taskId)
      if (node === null) return false
      const delta =
        node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.offset
      if (Math.abs(delta) < 0.5) return false
      restoreWrite = scroller.scrollTop + delta
      scroller.scrollTop += delta
      return true
    }

    const restore = (
      saved: NonNullable<typeof readingAnchorRef.current>,
      attempts: number,
      stable: number
    ): void => {
      restoreFrame = null
      let nextStable = stable
      if (correctToward(saved)) nextStable = 0
      else nextStable += 1
      if (attempts > 0 && nextStable < 2) {
        restoreFrame = requestAnimationFrame(() => restore(saved, attempts - 1, nextStable))
        return
      }
      restoring = false
      readingAnchorRef.current = saved
      scheduleCapture()
    }

    const beginRestore = (
      saved: NonNullable<typeof readingAnchorRef.current>,
      immediate: boolean
    ): void => {
      restoring = true
      if (captureFrame !== null) cancelAnimationFrame(captureFrame)
      if (restoreFrame !== null) cancelAnimationFrame(restoreFrame)
      captureFrame = null
      // Immediate (a page prepended above) corrects before paint — a
      // deferred correction would paint the wrong anchor for one frame.
      if (immediate) correctToward(saved)
      restoreFrame = requestAnimationFrame(() => restore(saved, 12, 0))
    }

    const observer = new ResizeObserver(() => {
      const nextWidth = scroller.clientWidth
      const nextHeight = gallery.getBoundingClientRect().height
      if (Math.abs(nextWidth - width) < 0.5 && Math.abs(nextHeight - height) < 0.5) return
      width = nextWidth
      height = nextHeight
      if (restoring) return
      const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      const saved = readingAnchorRef.current
      if (distanceFromBottom <= 2 || saved === null) {
        scheduleCapture()
        return
      }
      beginRestore(saved, false)
    })

    restoreReadingAnchorRef.current = beginRestore
    capture()
    observer.observe(scroller)
    observer.observe(gallery)
    const onScroll = (): void => {
      if (restoreWrite !== null) {
        const echo = restoreWrite
        restoreWrite = null
        if (Math.abs(scroller.scrollTop - echo) < 1) return
      }
      // The reader scrolled: their position supersedes any in-flight anchor
      // correction, which would otherwise reverse their scroll as drift.
      if (restoreFrame !== null) cancelAnimationFrame(restoreFrame)
      restoreFrame = null
      restoring = false
      capture()
      scheduleCapture()
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', onScroll)
      if (restoreReadingAnchorRef.current === beginRestore) {
        restoreReadingAnchorRef.current = null
      }
      if (captureFrame !== null) cancelAnimationFrame(captureFrame)
      if (restoreFrame !== null) cancelAnimationFrame(restoreFrame)
    }
  }, [galleryActive, scrollerRef])

  // This list shares the workspace scroller with the title above it. Feed
  // that live offset to the virtualizer so responsive/header changes do not
  // turn its item coordinates into fixed-height assumptions.
  const establishedMarginRef = useRef<number | null>(null)
  const measureMarginRef = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    const gallery = galleryRef.current
    const scroller = scrollerRef.current
    if (gallery === null || scroller === null) return
    const measure = (): void => {
      const next =
        gallery.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop
      // Content above the gallery (the history note) moving shifts every
      // card; scroll the same delta before paint to hold the reading
      // position. First establishment and a bottom-pinned reader (the bottom
      // follow owns those) do not bump; `established` survives effect
      // re-runs so a re-run re-establishes instead of double-bumping.
      const established = establishedMarginRef.current
      if (established !== null && Math.abs(next - established) >= 0.5) {
        const distanceFromBottom =
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
        if (distanceFromBottom > 2) scroller.scrollTop += next - established
      }
      establishedMarginRef.current = next
      setScrollMargin((current) => (Math.abs(current - next) < 0.5 ? current : next))
    }
    measure()
    measureMarginRef.current = measure
    const observer = new ResizeObserver(measure)
    observer.observe(gallery.parentElement ?? gallery)
    observer.observe(scroller)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      if (measureMarginRef.current === measure) measureMarginRef.current = null
    }
  }, [taskIds.length, scrollerRef])

  const remeasure = useCallback((): void => {
    measureMarginRef.current?.()
  }, [])

  useLayoutEffect(() => {
    const previousCount = previousTaskCountRef.current
    previousTaskCountRef.current = taskIds.length
    if (previousCount === taskIds.length) return
    const saved = readingAnchorRef.current
    if (saved !== null) restoreReadingAnchorRef.current?.(saved, true)
  }, [taskIds.length])

  return { galleryRef, virtualizer, scrollMargin, remeasure }
}
