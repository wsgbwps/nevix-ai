import { createContext, useContext } from 'react'

export type Theme = 'dark' | 'light'

export interface ThemeProviderState {
  readonly theme: Theme
  readonly setTheme: (theme: Theme) => void
}

export const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined)

export function useTheme(): ThemeProviderState {
  const context = useContext(ThemeProviderContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
