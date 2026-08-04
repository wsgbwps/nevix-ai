import { useEffect, useState, type ReactNode } from 'react'

import { ThemeProviderContext, type Theme } from '../hooks/use-theme'

interface ThemeProviderProps {
  readonly children: ReactNode
  readonly defaultTheme?: Theme
  readonly storageKey?: string
}

export function ThemeProvider({
  children,
  defaultTheme = 'dark',
  storageKey = 'nevix-ui-theme'
}: ThemeProviderProps): React.JSX.Element {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = localStorage.getItem(storageKey)
    return stored === 'dark' || stored === 'light' ? stored : defaultTheme
  })

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    root.classList.add(theme)
    // index.html 的防白闪占位底色写在内联样式上,优先级高于令牌,挂载后交还给 CSS
    document.body.style.removeProperty('background-color')
  }, [theme])

  function setTheme(nextTheme: Theme): void {
    localStorage.setItem(storageKey, nextTheme)
    setThemeState(nextTheme)
  }

  return (
    <ThemeProviderContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeProviderContext.Provider>
  )
}
