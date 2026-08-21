import '../../../app/globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CreationWorkbenchPrototype } from './creation-workbench-prototype'

document.documentElement.classList.add('dark')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main className="bg-background text-foreground flex h-screen min-h-0 overflow-hidden">
      <CreationWorkbenchPrototype includeProductRail />
    </main>
  </StrictMode>
)
