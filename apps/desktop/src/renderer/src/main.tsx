import './app/globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import { initializeRendererI18n, rendererI18n } from './app/i18n/renderer-i18n'
import { Providers } from './app/providers'

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
      </Providers>
    </StrictMode>
  )
}

void bootstrap()
