import './app/globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import { initializeRendererI18n } from './app/i18n/renderer-i18n'
import { Providers } from './app/providers'

async function bootstrap(): Promise<void> {
  const { interfaceLanguage, environment } = await window.api.invoke('i18n:get-bootstrap')
  await initializeRendererI18n(interfaceLanguage, environment)

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Providers>
        <App />
      </Providers>
    </StrictMode>
  )
}

void bootstrap()
