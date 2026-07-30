// Exact-path allowlist for the documented pre-migration Desktop architecture
// debt (see apps/desktop/AGENTS.md, "Migration and enforcement"). Every entry
// names one rule at one exact path with a reason and a verifiable removal
// trigger; the list only shrinks and unknown entries fail verification.
// This module must run directly in Node without a TypeScript runtime.
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const LEGACY_SEGMENT_REASON =
  'Documented migration debt: pre-Feature-Sliced segment names listed in apps/desktop/AGENTS.md.'

const entry = (rule, path, reason, removalTrigger) => ({
  rule,
  path,
  reason,
  removalTrigger
})

export const migrationDebtAllowlist = [
  // Authentication Feature legacy segments migrate opportunistically, not in bulk.
  entry(
    'renderer/segment-vocabulary',
    'src/renderer/src/features/authentication/components/authentication-screen.tsx',
    LEGACY_SEGMENT_REASON,
    'Removed when the segment responsibility next changes and the file moves to a canonical ui/ or model/ segment.'
  ),
  entry(
    'renderer/segment-vocabulary',
    'src/renderer/src/features/authentication/hooks/use-authentication.ts',
    LEGACY_SEGMENT_REASON,
    'Removed when the segment responsibility next changes and the file moves to a canonical ui/ or model/ segment.'
  )
]
