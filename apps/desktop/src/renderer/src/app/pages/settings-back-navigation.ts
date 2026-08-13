import type { RouterHistory } from '@tanstack/react-router'

export type SettingsBackHandler = () => void

export interface SettingsBackNavigation {
  readonly register: (handler: SettingsBackHandler) => () => void
}

export function coordinateSettingsBack(history: RouterHistory): SettingsBackNavigation {
  let activeHandler: SettingsBackHandler | undefined
  const back = history.back

  history.back = (options) => {
    if (!options?.ignoreBlocker && activeHandler) {
      activeHandler()
      return
    }
    back.call(history, options)
  }

  return {
    register: (handler) => {
      activeHandler = handler
      return () => {
        if (activeHandler === handler) activeHandler = undefined
      }
    }
  }
}
