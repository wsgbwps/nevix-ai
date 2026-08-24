import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isDesktopSource = context.parentURL?.includes('/apps/desktop/src/') === true
    const resolvedSpecifier =
      isDesktopSource && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)
        ? `${specifier}.ts`
        : specifier
    return nextResolve(resolvedSpecifier, context)
  }
})

const { createInMemoryGoAuthentication } =
  await import('../../src/renderer/src/features/authentication/api/in-memory-go-authentication.ts')
const { createInMemoryRememberedEmailPersistence } =
  await import('../../src/renderer/src/features/authentication/api/in-memory-remembered-email.ts')
const { createInMemorySessionPersistence } =
  await import('../../src/renderer/src/features/authentication/session/in-memory-session-persistence.ts')

const session = {
  token: 'opaque-session-token',
  expiresAt: '2026-01-01T00:00:00Z',
  user: {
    id: 'user-1',
    email: 'admin@example.com',
    displayName: 'admin',
    role: 'admin',
    mustChangePassword: false
  }
}

test('scripted semantic outcomes resolve in first-in-first-out order', async () => {
  const go = createInMemoryGoAuthentication()
  go.enqueue('signIn', { outcome: 'rate-limited' })
  go.enqueue('signIn', { outcome: 'succeeded', session })

  assert.deepEqual(await go.signIn('admin@example.com', 'secret'), { outcome: 'rate-limited' })
  assert.deepEqual(await go.signIn('admin@example.com', 'secret'), {
    outcome: 'succeeded',
    session
  })
  assert.deepEqual(go.calls, [
    { operation: 'signIn', email: 'admin@example.com', password: 'secret' },
    { operation: 'signIn', email: 'admin@example.com', password: 'secret' }
  ])
})

test('a deferred scripted outcome stays pending until the test releases it', async () => {
  const sessions = createInMemorySessionPersistence()
  let releaseRead!: (result: {
    outcome: 'stored'
    credentials: { token: string; expiresAt: string }
  }) => void
  const deferredRead = new Promise((resolve) => {
    releaseRead = resolve
  })
  sessions.enqueue('read', deferredRead)

  let settled = false
  const pendingRead = sessions.read().then((result) => {
    settled = true
    return result
  })

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(settled, false)

  releaseRead({
    outcome: 'stored',
    credentials: { token: 'opaque-session-token', expiresAt: '2026-01-01T00:00:00Z' }
  })
  assert.deepEqual(await pendingRead, {
    outcome: 'stored',
    credentials: { token: 'opaque-session-token', expiresAt: '2026-01-01T00:00:00Z' }
  })
})

test('completion order can be reversed while invocation order is recorded', async () => {
  const rememberedEmails = createInMemoryRememberedEmailPersistence()
  const completions: string[] = []

  let releaseReplace!: (result: { outcome: 'persisted' }) => void
  const deferredReplace = new Promise<{ outcome: 'persisted' }>((resolve) => {
    releaseReplace = resolve
  })
  let releaseClear!: (result: { outcome: 'cleared' }) => void
  const deferredClear = new Promise<{ outcome: 'cleared' }>((resolve) => {
    releaseClear = resolve
  })
  rememberedEmails.enqueue('replace', deferredReplace)
  rememberedEmails.enqueue('clear', deferredClear)

  const replace = rememberedEmails.replace('admin@example.com').then((result) => {
    completions.push(`replace:${result.outcome}`)
    return result
  })
  const clear = rememberedEmails.clear().then((result) => {
    completions.push(`clear:${result.outcome}`)
    return result
  })

  // The later invocation completes first: persistence-order tests need older
  // completion to lose against a newer selection.
  releaseClear({ outcome: 'cleared' })
  assert.deepEqual(await clear, { outcome: 'cleared' })
  releaseReplace({ outcome: 'persisted' })
  assert.deepEqual(await replace, { outcome: 'persisted' })

  assert.deepEqual(completions, ['clear:cleared', 'replace:persisted'])
  assert.deepEqual(rememberedEmails.calls, [
    { operation: 'replace', email: 'admin@example.com' },
    { operation: 'clear' }
  ])
})

test('every Go Authentication operation records its inputs for single-flight assertions', async () => {
  const go = createInMemoryGoAuthentication()
  go.enqueue('probeSetup', { outcome: 'succeeded', initialized: false, setupCodeRequired: true })
  go.enqueue('claimInstance', { outcome: 'succeeded', session })
  go.enqueue('register', { outcome: 'invalid-join-code' })
  go.enqueue('validateSession', { outcome: 'session-rejected' })
  go.enqueue('changePassword', { outcome: 'new-password-rejected' })
  go.enqueue('endSession', { outcome: 'unconfirmed' })

  await go.probeSetup()
  await go.claimInstance('first.admin@example.com', 'self-chosen-pass-1', 'AB23CD45', 'First Admin')
  await go.register('member@example.com', 'secret', 'JOIN-CODE', undefined)
  await go.validateSession('opaque-session-token')
  await go.changePassword('opaque-session-token', 'initial', 'replacement-pass-1')
  await go.endSession('opaque-session-token')

  assert.deepEqual(go.calls, [
    { operation: 'probeSetup' },
    {
      operation: 'claimInstance',
      email: 'first.admin@example.com',
      password: 'self-chosen-pass-1',
      setupCode: 'AB23CD45',
      displayName: 'First Admin'
    },
    {
      operation: 'register',
      email: 'member@example.com',
      password: 'secret',
      joinCode: 'JOIN-CODE',
      displayName: undefined
    },
    { operation: 'validateSession', token: 'opaque-session-token' },
    {
      operation: 'changePassword',
      token: 'opaque-session-token',
      currentPassword: 'initial',
      newPassword: 'replacement-pass-1'
    },
    { operation: 'endSession', token: 'opaque-session-token' }
  ])
})

test('session and remembered-email scripted outcomes record their inputs', async () => {
  const sessions = createInMemorySessionPersistence()
  sessions.enqueue('read', { outcome: 'empty' })
  sessions.enqueue('replace', { outcome: 'unavailable' })
  sessions.enqueue('clear', { outcome: 'clear-failed' })

  assert.deepEqual(await sessions.read(), { outcome: 'empty' })
  assert.deepEqual(await sessions.replace(session), { outcome: 'unavailable' })
  assert.deepEqual(await sessions.clear(), { outcome: 'clear-failed' })
  assert.deepEqual(sessions.calls, [
    { operation: 'read' },
    { operation: 'replace', session },
    { operation: 'clear' }
  ])

  const rememberedEmails = createInMemoryRememberedEmailPersistence()
  rememberedEmails.enqueue('read', {
    outcome: 'remembered',
    email: 'admin@example.com',
    persistence: 'memory-only'
  })
  rememberedEmails.enqueue('replace', { outcome: 'replace-failed' })
  rememberedEmails.enqueue('clear', { outcome: 'cleared' })

  assert.deepEqual(await rememberedEmails.read(), {
    outcome: 'remembered',
    email: 'admin@example.com',
    persistence: 'memory-only'
  })
  assert.deepEqual(await rememberedEmails.replace('admin@example.com'), {
    outcome: 'replace-failed'
  })
  assert.deepEqual(await rememberedEmails.clear(), { outcome: 'cleared' })
  assert.deepEqual(rememberedEmails.calls, [
    { operation: 'read' },
    { operation: 'replace', email: 'admin@example.com' },
    { operation: 'clear' }
  ])
})

test('an unscripted call rejects loudly instead of exercising real behavior', async () => {
  const go = createInMemoryGoAuthentication()
  const sessions = createInMemorySessionPersistence()
  const rememberedEmails = createInMemoryRememberedEmailPersistence()

  await assert.rejects(
    () => go.signIn('admin@example.com', 'secret') as Promise<never>,
    /No scripted result/
  )
  await assert.rejects(() => sessions.read() as Promise<never>, /No scripted result/)
  await assert.rejects(() => rememberedEmails.read() as Promise<never>, /No scripted result/)
})
