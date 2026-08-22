export type SettingsNavigateSemantics = 'navigable' | 'confirm-discard' | 'blocked'
export type SettingsCloseSemantics = 'allow' | 'confirm' | 'defer' | 'deny'

/**
 * What leaving the Settings Page means right now, in the vocabulary of the
 * Settings Flow module. Features derive these semantics from their own internal
 * state; they never leak that state across the seam.
 *
 * Invariant: `discard` is present exactly when `navigate` is `confirm-discard`
 * (and therefore `close` is `confirm`).
 */
export interface SettingsLeaveSemantics {
  readonly navigate: SettingsNavigateSemantics
  readonly close: SettingsCloseSemantics
  readonly discard?: () => void
}

export const CLEAN_LEAVE_SEMANTICS: SettingsLeaveSemantics = {
  navigate: 'navigable',
  close: 'allow'
}

export interface PendingSettingsDiscardPrompt {
  readonly continueEditing: () => void
  readonly discardChanges: () => void
}

/**
 * Paths that must never be held up by the Settings discard blocker: the
 * authentication flow owns the session lifecycle and outranks any unsaved
 * Settings draft.
 */
const FORCED_SECURITY_PATHS = new Set(['/auth'])

/**
 * How the router blocker should treat a navigation that would leave
 * `/settings`. `pass` lets it through, `block` refuses it outright, and
 * `confirm-discard` waits on the discard prompt.
 */
export function settingsNavigationBlockDecision(
  currentPathname: string,
  nextPathname: string,
  semantics: SettingsLeaveSemantics
): 'pass' | 'confirm-discard' | 'block' {
  if (currentPathname !== '/settings' || FORCED_SECURITY_PATHS.has(nextPathname)) {
    return 'pass'
  }
  return semantics.navigate === 'navigable'
    ? 'pass'
    : semantics.navigate === 'confirm-discard'
      ? 'confirm-discard'
      : 'block'
}

/**
 * How to answer an ordinary window-close request given the current semantics
 * and whether the discard prompt is already open. `queue` holds the request
 * until the open prompt settles.
 */
export function settingsCloseDecision(
  semantics: SettingsLeaveSemantics,
  discardPromptOpen: boolean
): 'allow' | 'cancel' | 'defer' | 'queue' | 'prompt' {
  if (semantics.close === 'allow') return 'allow'
  if (semantics.close === 'defer') return 'defer'
  if (semantics.close === 'deny') return 'cancel'
  return discardPromptOpen ? 'queue' : 'prompt'
}

/**
 * How to settle a close request that was deferred while a save was in flight
 * once the contribution reports new semantics: only a contribution that now
 * allows closing may close the window.
 */
export function resolveDeferredSettingsClose(
  semantics: SettingsLeaveSemantics
): 'allow' | 'cancel' {
  return semantics.close === 'allow' ? 'allow' : 'cancel'
}

/**
 * Attempt an in-page navigation (section switch, return to source) under the
 * current semantics. Mirrors {@link settingsNavigationBlockDecision} for
 * navigations the module initiates itself.
 */
export function settingsLeaveIntent(
  semantics: SettingsLeaveSemantics,
  navigate: () => void,
  openDiscardPrompt: (prompt: PendingSettingsDiscardPrompt) => boolean
): 'navigated' | 'confirmation-opened' | 'blocked' {
  if (semantics.navigate === 'navigable') {
    navigate()
    return 'navigated'
  }
  if (semantics.navigate !== 'confirm-discard') return 'blocked'

  return openDiscardPrompt({
    continueEditing: () => undefined,
    discardChanges: () => {
      semantics.discard?.()
      navigate()
    }
  })
    ? 'confirmation-opened'
    : 'blocked'
}
