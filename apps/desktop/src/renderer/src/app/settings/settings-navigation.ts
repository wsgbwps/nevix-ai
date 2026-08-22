export const SETTINGS_SECTIONS = ['profile', 'language', 'connection'] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export interface SettingsSourceDescriptor {
  readonly entryKey: string
  readonly pathname: string
}

export interface SettingsEntry {
  readonly section: SettingsSection
  readonly source: SettingsSourceDescriptor | undefined
}

interface HistoryLocationLike {
  readonly pathname: string
  readonly state: unknown
}

interface SettingsReturnHistory {
  readonly location: HistoryLocationLike
  canGoBack(): boolean
  back(options: { readonly ignoreBlocker: true }): void
  replace(pathname: string, state: undefined, options: { readonly ignoreBlocker: true }): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function historyEntryKey(state: unknown): string | undefined {
  if (!isRecord(state)) return undefined
  const key = state.__TSR_key ?? state.key
  return typeof key === 'string' && key.length > 0 ? key : undefined
}

function isSettingsSection(value: unknown): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section === value)
}

function readSource(value: unknown): SettingsSourceDescriptor | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.entryKey !== 'string' ||
    value.entryKey.length === 0 ||
    typeof value.pathname !== 'string'
  ) {
    return undefined
  }

  return {
    entryKey: value.entryKey,
    pathname: value.pathname
  }
}

export function captureSettingsSource(
  location: HistoryLocationLike
): SettingsSourceDescriptor | undefined {
  const entryKey = historyEntryKey(location.state)
  if (!entryKey) return undefined

  return { entryKey, pathname: location.pathname }
}

export function createSettingsEntry(location: HistoryLocationLike): SettingsEntry {
  return {
    section: 'profile',
    source: captureSettingsSource(location)
  }
}

export function readSettingsEntry(state: unknown): SettingsEntry {
  if (!isRecord(state) || !isRecord(state.settings)) {
    return { section: 'profile', source: undefined }
  }

  return {
    section: isSettingsSection(state.settings.section) ? state.settings.section : 'profile',
    source: readSource(state.settings.source)
  }
}

export function replaceSettingsSection(
  state: unknown,
  section: SettingsSection
): Record<string, unknown> {
  const historyState = isRecord(state) ? state : {}
  const entry = readSettingsEntry(historyState)
  return {
    ...historyState,
    settings: { ...entry, section }
  }
}

export function isMatchingSettingsSource(
  source: SettingsSourceDescriptor | undefined,
  location: HistoryLocationLike
): boolean {
  return (
    source !== undefined &&
    source.pathname === location.pathname &&
    source.entryKey === historyEntryKey(location.state)
  )
}

export function returnToSettingsSource(
  history: SettingsReturnHistory,
  source: SettingsSourceDescriptor | undefined,
  canEnterSource: (source: SettingsSourceDescriptor) => boolean
): 'source' | 'home' {
  const sourceIsEligible = source !== undefined && canEnterSource(source) && history.canGoBack()

  if (sourceIsEligible) {
    history.back({ ignoreBlocker: true })
    if (isMatchingSettingsSource(source, history.location)) return 'source'
  }

  history.replace('/', undefined, { ignoreBlocker: true })
  return 'home'
}
