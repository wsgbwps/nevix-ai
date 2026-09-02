import * as React from 'react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'

import { cn } from '@/lib/utils'

gsap.registerPlugin(useGSAP)

const baseClass =
  'bg-popover text-popover-foreground ring-foreground/10 z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-32 origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-xl p-1.5 shadow-md ring-1 duration-150 data-[state=closed]:overflow-hidden data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95'

/**
 * The composer's menu surface. GSAP owns the entrance (so the pop reads as
 * one smooth motion instead of the shared dropdown's CSS zoom) while the exit
 * must stay a CSS animation — Radix delays unmount on animationend, so a GSAP
 * exit would either block closing or be cut off.
 */
export function ComposerMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>): React.JSX.Element {
  const contentRef = React.useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      const content = contentRef.current
      if (content === null) return
      const media = gsap.matchMedia()
      media.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.fromTo(
          content,
          { autoAlpha: 0, scale: 0.96, y: 8 },
          {
            autoAlpha: 1,
            scale: 1,
            y: 0,
            duration: 0.24,
            ease: 'power3.out',
            transformOrigin: getComputedStyle(content).transformOrigin
          }
        )
      })
      return () => media.revert()
    },
    { scope: contentRef }
  )

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={contentRef}
        data-slot="composer-menu-content"
        className={cn(baseClass, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}
