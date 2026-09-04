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
