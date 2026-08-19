export const SETTINGS_SECTIONS = [
  'profile',
  'language',
  'organization-details',
  'members',
  'audit-log'
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export interface SettingsSourceDescriptor {
  readonly entryKey: string
  readonly pathname: string
  readonly organizationId: string | undefined
}

export interface SettingsEntry {
  readonly section: SettingsSection
  readonly source: SettingsSourceDescriptor | undefined
}

export interface SettingsOrganizationPickerEntry {
  readonly origin: 'settings'
  readonly phase: 'picker' | 'organization-create'
  readonly returnTo: SettingsEntry
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
    typeof value.pathname !== 'string' ||
    (value.organizationId !== undefined && typeof value.organizationId !== 'string')
  ) {
    return undefined
  }

  return {
    entryKey: value.entryKey,
    pathname: value.pathname,
    organizationId: value.organizationId
  }
}

export function captureSettingsSource(
  location: HistoryLocationLike,
  organizationId: string | undefined
): SettingsSourceDescriptor | undefined {
  const entryKey = historyEntryKey(location.state)
  if (!entryKey) return undefined

  return { entryKey, pathname: location.pathname, organizationId }
}

export function createSettingsEntry(
  location: HistoryLocationLike,
  organizationId: string | undefined
): SettingsEntry {
  return {
    section: 'profile',
    source: captureSettingsSource(location, organizationId)
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

export function createSettingsOrganizationPickerState(
  state: unknown,
  returnTo: SettingsEntry
): Record<string, unknown> {
  return {
    ...(isRecord(state) ? state : {}),
    organizationPicker: { origin: 'settings', phase: 'picker', returnTo }
  }
}

export function readSettingsOrganizationPickerEntry(
  state: unknown
): SettingsOrganizationPickerEntry | undefined {
  if (!isRecord(state) || !isRecord(state.organizationPicker)) return undefined
  const picker = state.organizationPicker
  if (
    picker.origin !== 'settings' ||
    (picker.phase !== 'picker' && picker.phase !== 'organization-create') ||
    !isRecord(picker.returnTo)
  ) {
    return undefined
  }
  if (!isSettingsSection(picker.returnTo.section)) return undefined

  const source =
    picker.returnTo.source === undefined ? undefined : readSource(picker.returnTo.source)
  if (picker.returnTo.source !== undefined && source === undefined) return undefined

  return {
    origin: 'settings',
    phase: picker.phase,
    returnTo: { section: picker.returnTo.section, source }
  }
}

export function replaceSettingsOrganizationPickerPhase(
  state: unknown,
  phase: SettingsOrganizationPickerEntry['phase']
): Record<string, unknown> {
  const historyState = isRecord(state) ? state : {}
  const picker = readSettingsOrganizationPickerEntry(historyState)
  if (!picker) return historyState
  return {
    ...historyState,
    organizationPicker: { ...picker, phase }
  }
}

export function restoreSettingsEntryAfterOrganizationPicker(
  state: unknown
): Record<string, unknown> {
  const historyState = isRecord(state) ? { ...state } : {}
  const picker = readSettingsOrganizationPickerEntry(historyState)
  delete historyState.organizationPicker
  if (picker) historyState.settings = picker.returnTo
  return historyState
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
  location: HistoryLocationLike,
  organizationId: string | undefined
): boolean {
  return (
    source !== undefined &&
    source.pathname === location.pathname &&
    source.entryKey === historyEntryKey(location.state) &&
    source.organizationId === organizationId
  )
}

export function returnToSettingsSource(
  history: SettingsReturnHistory,
  source: SettingsSourceDescriptor | undefined,
  organizationId: string | undefined,
  canEnterSource: (source: SettingsSourceDescriptor) => boolean
): 'source' | 'home' {
  const sourceIsEligible =
    source !== undefined &&
    source.organizationId === organizationId &&
    canEnterSource(source) &&
    history.canGoBack()

  if (sourceIsEligible) {
    history.back({ ignoreBlocker: true })
    if (isMatchingSettingsSource(source, history.location, organizationId)) return 'source'
  }

  history.replace('/', undefined, { ignoreBlocker: true })
  return 'home'
}
