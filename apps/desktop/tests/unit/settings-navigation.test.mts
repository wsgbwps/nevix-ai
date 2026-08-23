import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryHistory } from '@tanstack/react-router'
import { installSettingsBackInterception } from '../../src/renderer/src/app/settings/settings-back-navigation.ts'
import {
  captureSettingsSource,
  createSettingsEntry,
  isAdminSettingsSection,
  isMatchingSettingsSource,
  readSettingsEntry,
  replaceSettingsSection,
  resolveSettingsSection,
  returnToSettingsSource,
  type SettingsSourceDescriptor
} from '../../src/renderer/src/app/settings/settings-navigation.ts'
import { settingsLeaveIntent } from '../../src/renderer/src/app/settings/settings-leave-semantics.ts'

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
  const first = captureSettingsSource(sourceLocation('business-source-a'))
  const second = captureSettingsSource(sourceLocation('business-source-b'))

  assert.notDeepEqual(first, second)
  assert.equal(isMatchingSettingsSource(first, sourceLocation('business-source-a')), true)
  assert.equal(isMatchingSettingsSource(first, sourceLocation('business-source-b')), false)
  assert.equal(isMatchingSettingsSource(second, sourceLocation('business-source-b')), true)
})

test('Section replacement preserves the source and does not invent URL state', () => {
  const profileEntry = createSettingsEntry(sourceLocation('business-source'))
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

test('Admin-only sections resolve to Profile for sessions without the Admin role', () => {
  assert.equal(isAdminSettingsSection('users'), true)
  assert.equal(isAdminSettingsSection('audit'), true)
  assert.equal(isAdminSettingsSection('profile'), false)

  const usersEntry = readSettingsEntry({ settings: { section: 'users' } })
  assert.equal(resolveSettingsSection(usersEntry, false), 'profile')
  assert.equal(resolveSettingsSection(usersEntry, true), 'users')

  const profileEntry = readSettingsEntry(undefined)
  assert.equal(resolveSettingsSection(profileEntry, false), 'profile')
  assert.equal(resolveSettingsSection(profileEntry, true), 'profile')
})

function enterSettingsFromCurrentEntry(): {
  readonly history: ReturnType<typeof createMemoryHistory>
  readonly source: SettingsSourceDescriptor
} {
  const history = createMemoryHistory({ initialEntries: ['/'] })
  const source = captureSettingsSource(history.location)
  assert.ok(source)
  history.push('/settings', { settings: { section: 'profile', source } })
  return { history, source }
}

test('return uses the exact adjacent source when two business entries share a pathname', () => {
  const history = createMemoryHistory({ initialEntries: ['/'] })
  const firstEntryKey = history.location.state.__TSR_key
  history.push('/')
  const source = captureSettingsSource(history.location)
  assert.ok(source)
  history.push('/settings', { settings: { section: 'profile', source } })

  assert.equal(
    returnToSettingsSource(history, source, () => true),
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
      () => returnToSettingsSource(history, source, () => true),
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
      () => returnToSettingsSource(history, source, () => true),
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

test('an unusable source replaces Settings with Home', () => {
  const { history, source } = enterSettingsFromCurrentEntry()

  assert.equal(
    returnToSettingsSource(history, source, () => false),
    'home'
  )
  assert.equal(history.location.pathname, '/')
  assert.equal(history.location.state.__TSR_index, 1)
})
