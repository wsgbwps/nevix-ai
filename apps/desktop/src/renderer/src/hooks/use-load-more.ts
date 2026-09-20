import { useCallback, useEffect, useRef, useState } from 'react'

/** How far short of the list end the sentinel fires, so the next page lands first. */
const REACH_MARGIN_PX = 240

/** Attach the returned ref to a node at the end of a list to load its next page as it arrives. */
export function useLoadMore(options: {
  readonly onReach: () => void
  readonly disabled?: boolean
  /** The scrolling element, when the list scrolls inside one instead of the viewport. */
  readonly root?: React.RefObject<Element | null>
}): (node: HTMLElement | null) => void {
  const { onReach, disabled = false, root } = options
  const reach = useRef(onReach)
  const [node, setNode] = useState<HTMLElement | null>(null)

  useEffect(() => {
    reach.current = onReach
  })

  useEffect(() => {
    // Without IntersectionObserver the sentinel never fires, which leaves the
    // control the caller renders at this same node as the way to load more.
    if (disabled || node === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) reach.current()
      },
      { root: root?.current ?? null, rootMargin: `${REACH_MARGIN_PX}px` }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [disabled, node, root])

  return useCallback((element: HTMLElement | null) => setNode(element), [])
}
