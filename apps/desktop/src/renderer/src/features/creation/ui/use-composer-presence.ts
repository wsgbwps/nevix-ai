import { useCallback, useEffect, useRef, useState } from 'react'

// One notion of "at the bottom", shared by the back-to-bottom pill and the
// composer's presence.
const AT_BOTTOM_SLACK_PX = 120

export function isScrolledToBottom(scroller: HTMLElement): boolean {
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - AT_BOTTOM_SLACK_PX
}

/**
 * Presence machine for the dual-state Composer (完整态/紧凑态): expanded
 * while the workspace scroller sits at the bottom, compact once it scrolls
 * away. Pointer or focus intent inside the composer pins the expanded form
 * until the next scroll away — blur alone deliberately does not collapse.
 */
export function useComposerPresence({
  scrollerRef,
  rootRef
}: {
  readonly scrollerRef: React.RefObject<HTMLDivElement | null>
  readonly rootRef: React.RefObject<HTMLDivElement | null>
}): { readonly expanded: boolean; readonly pin: () => void } {
  const [expanded, setExpanded] = useState(true)
  const pinnedRef = useRef(false)

  // Pointer or focus intent inside the composer pins the expanded form.
  // DnD suppresses both events, so surfaces hosting drops (the deck) call
  // pin() from their own dragenter instead.
  const pin = useCallback((): void => {
    pinnedRef.current = true
    setExpanded(true)
  }, [])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null) return

    const sync = (): void => {
      const bottom = isScrolledToBottom(scroller)
      if (!bottom) pinnedRef.current = false
      setExpanded(bottom || pinnedRef.current)
    }

    sync()
    scroller.addEventListener('scroll', sync, { passive: true })
    return () => scroller.removeEventListener('scroll', sync)
  }, [scrollerRef])

  useEffect(() => {
    const root = rootRef.current
    if (root === null) return

    // pointerdown covers blank-surface clicks that land on nothing
    // focusable; focusin covers Tab and programmatic focus (the gallery's
    // re-edit jumps to the prompt field).
    root.addEventListener('pointerdown', pin)
    root.addEventListener('focusin', pin)
    return () => {
      root.removeEventListener('pointerdown', pin)
      root.removeEventListener('focusin', pin)
    }
  }, [pin, rootRef])

  return { expanded, pin }
}
