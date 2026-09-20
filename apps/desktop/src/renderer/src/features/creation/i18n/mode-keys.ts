// Mode wire ids → display keys in resources.ts; shared by the composer's
// mode menu and the gallery's task details, which render the same values.
export const modeKeys = {
  'text-to-image': 'composer.mode.text-to-image',
  'reference-image': 'composer.mode.reference-image',
  'text-to-video': 'composer.mode.text-to-video',
  'first-frame': 'composer.mode.first-frame',
  'first-last-frame': 'composer.mode.first-last-frame',
  'omni-reference': 'composer.mode.omni-reference'
} as const

type ModeKey = (typeof modeKeys)[keyof typeof modeKeys]

/**
 * The display key for a mode read off the wire. A value this build does not publish is handed back
 * as its own key — i18next renders an unknown key verbatim, so a newer server's mode still reaches
 * the UI. The cast is the one place that admits the key set is not closed.
 */
export function modeLabelKey(mode: string): ModeKey {
  return (modeKeys as Record<string, ModeKey | undefined>)[mode] ?? (mode as ModeKey)
}
