import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '../components/theme-provider'
import { rendererI18n } from './i18n/renderer-i18n'

export function Providers({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="nevix-ui-theme">
      <I18nextProvider i18n={rendererI18n}>{children}</I18nextProvider>
    </ThemeProvider>
  )
}
