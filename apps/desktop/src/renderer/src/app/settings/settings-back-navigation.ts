import type { RouterHistory } from '@tanstack/react-router'

export type SettingsBackHandler = () => void

/**
 * Intercept `history.back()` while installed so the Settings Flow can run its
 * leave semantics before the history actually moves. Navigations carrying
 * `ignoreBlocker` pass straight through. Installing and removing the
 * interception is paired with the Settings Page mount lifecycle, so no other
 * surface ever observes a patched history.
 */
export function installSettingsBackInterception(
  history: RouterHistory,
  handler: SettingsBackHandler
): () => void {
  const originalBack = history.back

  history.back = (options) => {
    if (!options?.ignoreBlocker && handler) {
      handler()
      return
    }
    originalBack.call(history, options)
  }

  return () => {
    history.back = originalBack
  }
}
