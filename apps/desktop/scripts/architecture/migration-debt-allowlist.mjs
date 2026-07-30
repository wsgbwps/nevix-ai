// Exact-path allowlist for the documented pre-migration Desktop architecture
// debt (see apps/desktop/AGENTS.md, "Migration and enforcement"). Every entry
// names one rule at one exact path with a reason and a verifiable removal
// trigger; the list only shrinks and unknown entries fail verification.
// This module must run directly in Node without a TypeScript runtime.
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const ATOMIC_MIGRATION =
  'Removed when the atomic Domain-first migration (.scratch/desktop-domain-first-architecture) lands and this path is deleted or renamed.'

const ADAPTER_FIRST_REASON =
  'Documented migration debt: Main IPC adapters still live under the Adapter-first src/main/ipc/ ownership.'

const LEGACY_MAIN_DOMAIN_REASON =
  'Documented migration debt: Language behavior still lives under the legacy settings/i18n Main Domain names.'

const LEGACY_SHARED_DOMAIN_REASON =
  'Documented migration debt: Language Channel declarations still live under the legacy settings/i18n shared IPC Domain names.'

const LEGACY_FEATURE_REASON =
  'Documented migration debt: the Language Mode renderer Feature still uses the legacy settings Domain name.'

const LEGACY_SEGMENT_REASON =
  'Documented migration debt: pre-Feature-Sliced segment names listed in apps/desktop/AGENTS.md.'

const LEGACY_CHANNEL_REASON =
  'Documented migration debt: renderer bootstrap still calls the legacy settings:/i18n: Language Channels.'

const entry = (rule, path, reason, removalTrigger = ATOMIC_MIGRATION) => ({
  rule,
  path,
  reason,
  removalTrigger
})

export const migrationDebtAllowlist = [
  // Adapter-first Main IPC ownership (src/main/ipc/) awaiting the Domain move.
  entry(
    'main/adapter-first-ipc',
    'src/main/ipc/authentication/clear-session.ts',
    ADAPTER_FIRST_REASON
  ),
  entry('main/adapter-first-ipc', 'src/main/ipc/authentication/index.ts', ADAPTER_FIRST_REASON),
  entry(
    'main/adapter-first-ipc',
    'src/main/ipc/authentication/read-session.ts',
    ADAPTER_FIRST_REASON
  ),
  entry(
    'main/adapter-first-ipc',
    'src/main/ipc/authentication/replace-session.ts',
    ADAPTER_FIRST_REASON
  ),
  entry(
    'main/adapter-first-ipc',
    'src/main/ipc/authentication/trusted-sender.ts',
    ADAPTER_FIRST_REASON
  ),
  entry(
    'main/adapter-first-ipc',
    'src/main/ipc/i18n/handlers/get-bootstrap.ts',
    ADAPTER_FIRST_REASON
  ),
  entry('main/adapter-first-ipc', 'src/main/ipc/i18n/index.ts', ADAPTER_FIRST_REASON),
  entry(
    'main/adapter-first-ipc',
    'src/main/ipc/settings/handlers/get-language-mode.ts',
    ADAPTER_FIRST_REASON
  ),
  entry(
    'main/adapter-first-ipc',
    'src/main/ipc/settings/handlers/set-language-mode.ts',
    ADAPTER_FIRST_REASON
  ),
  entry('main/adapter-first-ipc', 'src/main/ipc/settings/index.ts', ADAPTER_FIRST_REASON),

  // Legacy settings/i18n Main ownership awaiting the Language Domain consolidation.
  entry('main/legacy-domain-name', 'src/main/i18n/i18next.d.ts', LEGACY_MAIN_DOMAIN_REASON),
  entry('main/legacy-domain-name', 'src/main/i18n/index.ts', LEGACY_MAIN_DOMAIN_REASON),
  entry('main/legacy-domain-name', 'src/main/i18n/resources.ts', LEGACY_MAIN_DOMAIN_REASON),
  entry(
    'main/legacy-domain-name',
    'src/main/settings/language-mode-store.ts',
    LEGACY_MAIN_DOMAIN_REASON
  ),

  // The composition root still discovers registration modules with the
  // Adapter-first glob; it switches to ./*/ipc/index.ts in the same atomic move.
  entry(
    'main/registration-discovery',
    'src/main/index.ts',
    'Documented migration debt: discovery still uses the Adapter-first ./ipc/*/index.ts glob that pairs with src/main/ipc/.'
  ),

  // Legacy shared IPC Domain declarations awaiting the language rename.
  entry('shared/legacy-domain-name', 'src/shared/ipc/i18n/types.ts', LEGACY_SHARED_DOMAIN_REASON),
  entry(
    'shared/legacy-domain-name',
    'src/shared/ipc/settings/types.ts',
    LEGACY_SHARED_DOMAIN_REASON
  ),

  // The Language Mode Feature still carries the legacy settings name.
  entry(
    'renderer/legacy-feature-name',
    'src/renderer/src/features/settings/i18n.ts',
    LEGACY_FEATURE_REASON
  ),
  entry(
    'renderer/legacy-feature-name',
    'src/renderer/src/features/settings/index.ts',
    LEGACY_FEATURE_REASON
  ),
  entry(
    'renderer/legacy-feature-name',
    'src/renderer/src/features/settings/ui/language-mode-settings.tsx',
    LEGACY_FEATURE_REASON
  ),

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
  ),

  // Renderer bootstrap consumes the legacy Language Channels until the rename.
  entry('channels/legacy-language-prefix', 'src/renderer/src/main.tsx', LEGACY_CHANNEL_REASON)
]
