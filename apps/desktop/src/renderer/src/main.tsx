import './app/globals.css'

import {
  lazy,
  StrictMode,
  Suspense,
  useEffect,
  useState,
  type ComponentType,
  type ReactElement
} from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import { initializeRendererI18n, rendererI18n } from './app/i18n/renderer-i18n'
import { Providers } from './app/providers'

// dev-only: click-to-source inspector; statically eliminated from production builds.
// Hold Option(Alt) to activate, click an element to open its source; release to exit.
// Note: Ctrl is unusable here since macOS turns Ctrl+click into a right-click (contextmenu).
const DevInspector: ComponentType = import.meta.env.DEV
  ? lazy(async () => {
      const { Inspector } = await import('react-dev-inspector')

      const HoldToInspect = (): ReactElement => {
        const [active, setActive] = useState(false)

        useEffect(() => {
          const update = (event: KeyboardEvent): void => setActive(event.altKey)
          const reset = (): void => setActive(false)
          window.addEventListener('keydown', update)
          window.addEventListener('keyup', update)
          window.addEventListener('blur', reset)
          return () => {
            window.removeEventListener('keydown', update)
            window.removeEventListener('keyup', update)
            window.removeEventListener('blur', reset)
          }
        }, [])

        return <Inspector keys={null} active={active} />
      }

      return { default: HoldToInspect }
    })
  : () => null

async function bootstrap(): Promise<void> {
  const { interfaceLanguage, environment } = await window.api.invoke('language:get-bootstrap')
  await initializeRendererI18n(interfaceLanguage, environment)
  window.api.on(
    'language:language-mode-changed',
    ({ interfaceLanguage: nextInterfaceLanguage }) => {
      void rendererI18n.changeLanguage(nextInterfaceLanguage)
    }
  )

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Providers>
        <App />
        {import.meta.env.DEV && (
          <Suspense fallback={null}>
            <DevInspector />
          </Suspense>
        )}
      </Providers>
    </StrictMode>
  )
}

void bootstrap()
