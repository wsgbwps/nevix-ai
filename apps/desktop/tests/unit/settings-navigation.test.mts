import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryHistory } from '@tanstack/react-router'
import { installSettingsBackInterception } from '../../src/renderer/src/app/settings/settings-back-navigation.ts'
import {
  captureSettingsSource,
  createSettingsEntry,
  createSettingsOrganizationPickerState,
  isMatchingSettingsSource,
  readSettingsEntry,
  readSettingsOrganizationPickerEntry,
  replaceSettingsOrganizationPickerPhase,
  replaceSettingsSection,
  restoreSettingsEntryAfterOrganizationPicker,
  returnToSettingsSource,
  type SettingsSourceDescriptor
} from '../../src/renderer/src/app/settings/settings-navigation.ts'
import { settingsLeaveIntent } from '../../src/renderer/src/app/settings/settings-leave-semantics.ts'

const organizationId = '91ef8acc-287c-45fa-9c4-a67b2ade6a12'

function sourceLocation(key: string): {
  readonly pathname: '/'
  readonly state: { readonly __TSR_key: string; readonly __TSR_index: 0 }
} {
  return {
    pathname: '/',
    state: { __TSR_key: key, __TSR_index: 0 }
  }
}

test('same-path business entries remain distinct Settings return sources', () => {
  const first = captureSettingsSource(sourceLocation('business-source-a'), organizationId)
  const second = captureSettingsSource(sourceLocation('business-source-b'), organizationId)

  assert.notDeepEqual(first, second)
  assert.equal(
    isMatchingSettingsSource(first, sourceLocation('business-source-a'), organizationId),
    true
  )
  assert.equal(
    isMatchingSettingsSource(first, sourceLocation('business-source-b'), organizationId),
    false
  )
  assert.equal(
    isMatchingSettingsSource(second, sourceLocation('business-source-b'), organizationId),
    true
  )
})

test('a source becomes invalid after its Organization context changes', () => {
  const source = captureSettingsSource(sourceLocation('business-source'), organizationId)

  assert.equal(
    isMatchingSettingsSource(
      source,
      sourceLocation('business-source'),
      '0d7d044e-b84e-409d-a74c-f2c12567c721'
    ),
    false
  )
})

test('Section replacement preserves the source and does not invent URL state', () => {
  const profileEntry = createSettingsEntry(sourceLocation('business-source'), organizationId)
  const languageState = replaceSettingsSection(
    { __TSR_key: 'settings-entry', __TSR_index: 1, settings: profileEntry },
    'language'
  )

  assert.deepEqual(readSettingsEntry(languageState), {
    section: 'language',
    source: profileEntry.source
  })
})

test('invalid or absent Settings state safely defaults to Profile without a source', () => {
  assert.deepEqual(readSettingsEntry(undefined), { section: 'profile', source: undefined })
  assert.deepEqual(readSettingsEntry({ settings: { section: 'not-a-section' } }), {
    section: 'profile',
    source: undefined
  })
})

function enterSettingsFromCurrentEntry(): {
  readonly history: ReturnType<typeof createMemoryHistory>
  readonly source: SettingsSourceDescriptor
} {
  const history = createMemoryHistory({ initialEntries: ['/'] })
  const source = captureSettingsSource(history.location, organizationId)
  assert.ok(source)
  history.push('/settings', { settings: { section: 'profile', source } })
  return { history, source }
}

test('return uses the exact adjacent source when two business entries share a pathname', () => {
  const history = createMemoryHistory({ initialEntries: ['/'] })
  const firstEntryKey = history.location.state.__TSR_key
  history.push('/')
  const source = captureSettingsSource(history.location, organizationId)
  assert.ok(source)
  history.push('/settings', { settings: { section: 'profile', source } })

  assert.equal(
    returnToSettingsSource(history, source, organizationId, () => true),
    'source'
  )
  assert.equal(history.location.pathname, '/')
  assert.equal(history.location.state.__TSR_key, source.entryKey)
  assert.notEqual(history.location.state.__TSR_key, firstEntryKey)
})

test('dirty back stays on Settings until discard confirms the coordinated return', () => {
  const { history, source } = enterSettingsFromCurrentEntry()
  let discarded = false
  let prompt:
    | {
        readonly continueEditing: () => void
        readonly discardChanges: () => void
      }
    | undefined

  let result: ReturnType<typeof settingsLeaveIntent> | undefined
  const removeInterception = installSettingsBackInterception(history, () => {
    result = settingsLeaveIntent(
      { navigate: 'confirm-discard', close: 'confirm', discard: () => (discarded = true) },
      () => returnToSettingsSource(history, source, organizationId, () => true),
      (nextPrompt) => {
        prompt = nextPrompt
        return true
      }
    )
  })
  history.back()

  assert.equal(result, 'confirmation-opened')
  assert.equal(history.location.pathname, '/settings')
  prompt?.discardChanges()
  assert.equal(discarded, true)
  assert.equal(history.location.state.__TSR_key, source.entryKey)
  removeInterception()
})

test('saving back is blocked without mutating memory history', () => {
  const { history, source } = enterSettingsFromCurrentEntry()

  let result: ReturnType<typeof settingsLeaveIntent> | undefined
  const removeInterception = installSettingsBackInterception(history, () => {
    result = settingsLeaveIntent(
      { navigate: 'blocked', close: 'defer' },
      () => returnToSettingsSource(history, source, organizationId, () => true),
      () => true
    )
  })
  history.back()

  assert.equal(result, 'blocked')
  assert.equal(history.location.pathname, '/settings')
  removeInterception()
})

test('back interception passes blocker-exempt calls through and restores the original back', () => {
  const { history } = enterSettingsFromCurrentEntry()
  let intercepted = 0
  const removeInterception = installSettingsBackInterception(history, () => {
    intercepted += 1
  })

  history.back({ ignoreBlocker: true })
  assert.equal(intercepted, 0)
  assert.equal(history.location.pathname, '/')

  history.push('/settings')
  history.back()
  assert.equal(intercepted, 1)

  removeInterception()
  history.back()
  assert.equal(intercepted, 1)
})

test('an invalid Organization-bound source replaces Settings with Home', () => {
  const { history, source } = enterSettingsFromCurrentEntry()

  assert.equal(
    returnToSettingsSource(history, source, '0d7d044e-b84e-409d-a74c-f2c12567c721', () => true),
    'home'
  )
  assert.equal(history.location.pathname, '/')
  assert.equal(history.location.state.__TSR_index, 1)
})

test('Settings picker state preserves the exact return Section and source until restoration', () => {
  const source = captureSettingsSource(sourceLocation('business-source'), organizationId)
  assert.ok(source)
  const settingsEntry = { section: 'audit-log', source } as const
  const pickerState = createSettingsOrganizationPickerState(
    { __TSR_key: 'settings-entry', __TSR_index: 1, settings: settingsEntry },
    settingsEntry
  )

  assert.deepEqual(readSettingsOrganizationPickerEntry(pickerState), {
    origin: 'settings',
    phase: 'picker',
    returnTo: settingsEntry
  })

  const creationState = replaceSettingsOrganizationPickerPhase(pickerState, 'organization-create')
  assert.deepEqual(readSettingsOrganizationPickerEntry(creationState), {
    origin: 'settings',
    phase: 'organization-create',
    returnTo: settingsEntry
  })

  const restoredState = restoreSettingsEntryAfterOrganizationPicker(pickerState)
  assert.deepEqual(readSettingsEntry(restoredState), settingsEntry)
  assert.equal(readSettingsOrganizationPickerEntry(restoredState), undefined)
})

test('malformed picker state remains startup-origin and cannot invent a Settings return target', () => {
  for (const state of [
    undefined,
    { organizationPicker: { origin: 'startup' } },
    { organizationPicker: { origin: 'settings', returnTo: { section: 'unknown' } } }
  ]) {
    assert.equal(readSettingsOrganizationPickerEntry(state), undefined)
  }
})
