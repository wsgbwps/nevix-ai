import { useEffect } from 'react'

/** Document listeners also cover nested scrollers and portalled menus. */
export function Scrollbars(): null {
  useEffect(() => {
    const timers = new Map<Element, ReturnType<typeof setTimeout>>()
    let hovered: Element | null = null
    let dragging: Element | null = null

    const show = (element: Element): void => {
      clearTimeout(timers.get(element))
      timers.delete(element)
      element.setAttribute('data-scrollbar', '')
      element.setAttribute('data-scrollbar-visible', '')
    }
    const hideLater = (element: Element): void => {
      clearTimeout(timers.get(element))
      timers.delete(element)
      if (element === hovered || element === dragging) return
      timers.set(
        element,
        setTimeout(() => {
          element.removeAttribute('data-scrollbar-visible')
          timers.delete(element)
        }, 1000)
      )
    }
    const onScroll = (event: Event): void => {
      const element = event.target === document ? document.documentElement : event.target
      if (!(element instanceof Element)) return
      show(element)
      hideLater(element)
    }
    const nearScrollbar = (event: PointerEvent): Element | null => {
      let element = event.target instanceof Element ? event.target : null
      while (element !== null) {
        const vertical = element.scrollHeight > element.clientHeight
        const horizontal = element.scrollWidth > element.clientWidth
        if (vertical || horizontal) {
          const style = getComputedStyle(element)
          const root = element === document.documentElement
          const bounds = root
            ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
            : element.getBoundingClientRect()
          const x = event.clientX - bounds.left
          const y = event.clientY - bounds.top
          // Include a few content pixels so a hidden native scrollbar is discoverable.
          const atVertical = style.direction === 'rtl' ? x <= 12 : x >= bounds.width - 12
          if (
            x >= 0 &&
            x <= bounds.width &&
            y >= 0 &&
            y <= bounds.height &&
            ((vertical && (root || /auto|scroll/.test(style.overflowY)) && atVertical) ||
              (horizontal &&
                (root || /auto|scroll/.test(style.overflowX)) &&
                y >= bounds.height - 12))
          )
            return element
        }
        element = element.parentElement
      }
      return null
    }
    const setHovered = (next: Element | null): void => {
      if (next === hovered) return
      const previous = hovered
      hovered = next
      if (previous !== null) {
        previous.removeAttribute('data-scrollbar-hovered')
        hideLater(previous)
      }
      if (next !== null) {
        next.setAttribute('data-scrollbar-hovered', '')
        show(next)
      }
    }
    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') setHovered(nearScrollbar(event))
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || event.pointerType === 'touch') return
      dragging = nearScrollbar(event)
      if (dragging !== null) show(dragging)
    }
    const release = (): void => {
      const previous = dragging
      dragging = null
      if (previous !== null) hideLater(previous)
    }
    const leave = (): void => setHovered(null)
    const reset = (): void => {
      leave()
      release()
    }

    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerleave', leave)
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', reset, true)
    window.addEventListener('blur', reset)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerleave', leave)
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', reset, true)
      window.removeEventListener('blur', reset)
      timers.forEach(clearTimeout)
      document.querySelectorAll('[data-scrollbar]').forEach((element) => {
        element.removeAttribute('data-scrollbar')
        element.removeAttribute('data-scrollbar-visible')
        element.removeAttribute('data-scrollbar-hovered')
      })
    }
  }, [])
  return null
}
