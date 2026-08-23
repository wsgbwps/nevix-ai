import assert from 'node:assert/strict'
import { suite, test } from 'node:test'
import {
  CLEAN_LEAVE_SEMANTICS,
  reduceLeaveSemantics,
  resolveDeferredSettingsClose,
  settingsCloseDecision,
  settingsLeaveIntent,
  settingsNavigationBlockDecision,
  type SettingsLeaveSemantics
} from '../../src/renderer/src/app/settings/settings-leave-semantics.ts'

const discardable: SettingsLeaveSemantics = {
  navigate: 'confirm-discard',
  close: 'confirm',
  discard: () => undefined
}

test('clean leave semantics navigate and close freely', () => {
  assert.deepEqual(
    { navigate: CLEAN_LEAVE_SEMANTICS.navigate, close: CLEAN_LEAVE_SEMANTICS.close },
    { navigate: 'navigable', close: 'allow' }
  )
  assert.equal(CLEAN_LEAVE_SEMANTICS.discard, undefined)
})

// --- settingsLeaveIntent: section switch / return-to-source ------------------

test('navigable contribution navigates immediately', () => {
  let navigated = false
  const outcome = settingsLeaveIntent(
    CLEAN_LEAVE_SEMANTICS,
    () => {
      navigated = true
    },
    () => false
  )

  assert.equal(outcome, 'navigated')
  assert.equal(navigated, true)
})

test('blocked contribution refuses to navigate', () => {
  let navigated = false
  const outcome = settingsLeaveIntent(
    { navigate: 'blocked', close: 'deny' },
    () => {
      navigated = true
    },
    () => false
  )

  assert.equal(outcome, 'blocked')
  assert.equal(navigated, false)
})

test('discardable contribution opens the discard prompt and discards on confirm', () => {
  let discarded = false
  let navigated = false
  const semantics: SettingsLeaveSemantics = {
    ...discardable,
    discard: () => {
      discarded = true
    }
  }
  let handedOver: { continueEditing(): void; discardChanges(): void } | undefined
  const outcome = settingsLeaveIntent(
    semantics,
    () => {
      navigated = true
    },
    (prompt) => {
      handedOver = prompt
      return true
    }
  )

  assert.equal(outcome, 'confirmation-opened')
  assert.equal(navigated, false)
  assert.ok(handedOver)
  handedOver.discardChanges()
  assert.equal(discarded, true)
  assert.equal(navigated, true)
})

test('discardable contribution stays put when a prompt is already open', () => {
  const outcome = settingsLeaveIntent(
    discardable,
    () => undefined,
    () => false
  )
  assert.equal(outcome, 'blocked')
})

// --- settingsNavigationBlockDecision: router blocker --------------------------

test('navigation away from settings is never blocked while outside settings', () => {
  assert.equal(
    settingsNavigationBlockDecision('/', '/settings', { navigate: 'blocked', close: 'deny' }),
    'pass'
  )
})

test('security paths are always allowed through the blocker', () => {
  assert.equal(settingsNavigationBlockDecision('/settings', '/auth', discardable), 'pass')
})

test('blocker follows the navigate semantics otherwise', () => {
  assert.equal(settingsNavigationBlockDecision('/settings', '/', CLEAN_LEAVE_SEMANTICS), 'pass')
  assert.equal(settingsNavigationBlockDecision('/settings', '/', discardable), 'confirm-discard')
  assert.equal(
    settingsNavigationBlockDecision('/settings', '/', { navigate: 'blocked', close: 'defer' }),
    'block'
  )
})

// --- settingsCloseDecision: ordinary close interleavings ---------------------

test('close decision follows the close semantics', () => {
  assert.equal(settingsCloseDecision(CLEAN_LEAVE_SEMANTICS, false), 'allow')
  assert.equal(settingsCloseDecision({ navigate: 'blocked', close: 'defer' }, false), 'defer')
  assert.equal(settingsCloseDecision({ navigate: 'blocked', close: 'deny' }, false), 'cancel')
})

test('confirming close opens a prompt only when none is open, otherwise queues', () => {
  assert.equal(settingsCloseDecision(discardable, false), 'prompt')
  assert.equal(settingsCloseDecision(discardable, true), 'queue')
})

// --- resolveDeferredSettingsClose: saved-through-close resolution -------------

test('a deferred close is allowed only once the contribution allows closing', () => {
  assert.equal(resolveDeferredSettingsClose(CLEAN_LEAVE_SEMANTICS), 'allow')
  assert.equal(resolveDeferredSettingsClose(discardable), 'cancel')
  assert.equal(resolveDeferredSettingsClose({ navigate: 'blocked', close: 'deny' }), 'cancel')
})

suite('reduceLeaveSemantics combines two contributors of one surface', () => {
  test('two clean contributors stay clean', () => {
    assert.deepEqual(
      reduceLeaveSemantics(CLEAN_LEAVE_SEMANTICS, CLEAN_LEAVE_SEMANTICS),
      CLEAN_LEAVE_SEMANTICS
    )
  })

  test('a command in flight on either card blocks leaving and closes', () => {
    const unresolved: SettingsLeaveSemantics = { navigate: 'blocked', close: 'deny' }
    assert.deepEqual(reduceLeaveSemantics(unresolved, CLEAN_LEAVE_SEMANTICS), unresolved)
    assert.deepEqual(reduceLeaveSemantics(CLEAN_LEAVE_SEMANTICS, unresolved), unresolved)
  })

  test('a blocked contributor outranks a pending discard prompt', () => {
    const reduced = reduceLeaveSemantics(discardable, { navigate: 'blocked', close: 'deny' })
    assert.deepEqual(
      { navigate: reduced.navigate, close: reduced.close },
      { navigate: 'blocked', close: 'deny' }
    )
    // The discard invariant survives: no discard while navigate is not confirm-discard.
    assert.equal(reduced.discard, undefined)
  })

  test('a pending discard survives next to a clean contributor and composes both discards', () => {
    const calls: string[] = []
    const first: SettingsLeaveSemantics = {
      navigate: 'confirm-discard',
      close: 'confirm',
      discard: () => calls.push('first')
    }
    const second: SettingsLeaveSemantics = {
      navigate: 'confirm-discard',
      close: 'confirm',
      discard: () => calls.push('second')
    }
    const reducedBoth = reduceLeaveSemantics(first, second)
    assert.equal(reducedBoth.navigate, 'confirm-discard')
    assert.equal(reducedBoth.close, 'confirm')
    reducedBoth.discard?.()
    assert.deepEqual(calls, ['first', 'second'])

    const reducedWithClean = reduceLeaveSemantics(first, CLEAN_LEAVE_SEMANTICS)
    reducedWithClean.discard?.()
    assert.deepEqual(calls, ['first', 'second', 'first'])
  })
})
