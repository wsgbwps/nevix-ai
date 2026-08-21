import { useEffect } from 'react'
import { ArrowLeftIcon, ArrowRightIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

export const PROTOTYPE_VARIANTS = ['A', 'B', 'C'] as const

export type PrototypeVariant = (typeof PROTOTYPE_VARIANTS)[number]

const variantNames: Record<PrototypeVariant, string> = {
  A: '频道画廊',
  B: '双源展厅',
  C: '检索工作台'
}

export function InspirationPrototypeSwitcher({
  variant,
  onVariantChange
}: {
  readonly variant: PrototypeVariant
  readonly onVariantChange: (variant: PrototypeVariant) => void
}): React.JSX.Element | null {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return

      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return
      }

      const currentIndex = PROTOTYPE_VARIANTS.indexOf(variant)
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      const nextIndex =
        (currentIndex + direction + PROTOTYPE_VARIANTS.length) % PROTOTYPE_VARIANTS.length
      onVariantChange(PROTOTYPE_VARIANTS[nextIndex])
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onVariantChange, variant])

  if (import.meta.env.PROD) return null

  function cycle(direction: -1 | 1): void {
    const currentIndex = PROTOTYPE_VARIANTS.indexOf(variant)
    const nextIndex =
      (currentIndex + direction + PROTOTYPE_VARIANTS.length) % PROTOTYPE_VARIANTS.length
    onVariantChange(PROTOTYPE_VARIANTS[nextIndex])
  }

  return (
    <div className="fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-neutral-950/95 px-2 py-2 text-white shadow-2xl backdrop-blur">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="rounded-full text-white hover:bg-white/15 hover:text-white"
        aria-label="上一个原型方案"
        onClick={() => cycle(-1)}
      >
        <ArrowLeftIcon />
      </Button>
      <div className="min-w-32 text-center text-xs font-medium">
        {variant} — {variantNames[variant]}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="rounded-full text-white hover:bg-white/15 hover:text-white"
        aria-label="下一个原型方案"
        onClick={() => cycle(1)}
      >
        <ArrowRightIcon />
      </Button>
    </div>
  )
}
