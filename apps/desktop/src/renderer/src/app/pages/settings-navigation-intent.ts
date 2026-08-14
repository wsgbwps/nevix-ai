export type SettingsNavigationContribution =
  | { readonly status: 'clean' }
  | { readonly status: 'dirty'; readonly discard: () => void }
  | { readonly status: 'saving' }
  | { readonly status: 'command-pending' }
  | { readonly status: 'unknown-command-result' }
  | { readonly status: 'audit-export-active' }

export interface PendingSettingsDiscardPrompt {
  readonly continueEditing: () => void
  readonly discardChanges: () => void
}

export function runSettingsNavigationIntent(
  contribution: SettingsNavigationContribution,
  navigate: () => void,
  openDiscardPrompt: (prompt: PendingSettingsDiscardPrompt) => boolean
): 'navigated' | 'confirmation-opened' | 'blocked' {
  if (contribution.status === 'clean') {
    navigate()
    return 'navigated'
  }
  if (contribution.status !== 'dirty') return 'blocked'

  return openDiscardPrompt({
    continueEditing: () => undefined,
    discardChanges: () => {
      contribution.discard()
      navigate()
    }
  })
    ? 'confirmation-opened'
    : 'blocked'
}
