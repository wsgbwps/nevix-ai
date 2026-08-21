/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SparklesIcon } from 'lucide-react'
import {
  InspirationPrototypePage,
  PROTOTYPE_VARIANTS,
  type PrototypeVariant
} from '../features/creation'
import './globals.css'

function readVariant(): PrototypeVariant {
  const candidate = new URLSearchParams(window.location.search).get('variant')
  return PROTOTYPE_VARIANTS.find((variant) => variant === candidate) ?? 'A'
}

function InspirationPrototypePreview(): React.JSX.Element {
  const [variant, setVariant] = useState<PrototypeVariant>(readVariant)

  function selectVariant(nextVariant: PrototypeVariant): void {
    setVariant(nextVariant)
    window.history.replaceState(null, '', `?variant=${nextVariant}`)
  }

  return (
    <div className="bg-background text-foreground grid min-h-screen grid-cols-[72px_1fr]">
      <aside className="border-border bg-card flex flex-col items-center border-r py-5">
        <div className="bg-foreground text-background grid size-9 place-items-center rounded-xl text-sm font-semibold">
          N
        </div>
        <SparklesIcon className="text-primary mt-10 size-5" aria-label="AI 创作" />
      </aside>
      <div className="min-w-0">
        <header className="border-border bg-background/90 sticky top-0 z-50 flex h-14 items-center border-b px-6 backdrop-blur">
          <p className="text-sm font-medium">灵感页原型 · 独立预览</p>
          <p className="text-muted-foreground ml-auto text-xs">无需登录 · 仅内存数据</p>
        </header>
        <InspirationPrototypePage variant={variant} onVariantChange={selectVariant} />
      </div>
    </div>
  )
}

document.documentElement.classList.add('dark')

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Prototype root element is missing')

createRoot(rootElement).render(<InspirationPrototypePreview />)
