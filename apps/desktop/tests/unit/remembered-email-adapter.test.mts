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

type InvokeCall = { readonly channel: string; readonly request?: unknown }

function installWindowApi(handler: (channel: string, request?: unknown) => Promise<unknown>): {
  readonly calls: InvokeCall[]
} {
  const calls: InvokeCall[] = []
  ;(globalThis as { window?: unknown }).window = {
    api: {
      invoke: (channel: string, request?: unknown) => {
        calls.push(request === undefined ? { channel } : { channel, request })
        return handler(channel, request)
      }
    }
  }
  return { calls }
}

const { createRememberedEmailPersistenceOverIpc } =
  await import('../../src/renderer/src/features/authentication/api/remembered-email.ts')

test.afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

test('reading reports a remembered email with its secure or memory-only persistence', async () => {
  const rememberedEmails = createRememberedEmailPersistenceOverIpc()
  const { calls } = installWindowApi(async (channel) => {
    if (channel === 'authentication:read-remembered-email') {
      return { outcome: 'email', email: 'admin@example.com', persistence: 'secure' }
    }
    return undefined
  })

  assert.deepEqual(await rememberedEmails.read(), {
    outcome: 'remembered',
    email: 'admin@example.com',
    persistence: 'secure'
  })
  assert.deepEqual(calls, [{ channel: 'authentication:read-remembered-email' }])

  installWindowApi(async () => ({
    outcome: 'email',
    email: 'admin@example.com',
    persistence: 'memory-only'
  }))
  assert.deepEqual(await rememberedEmails.read(), {
    outcome: 'remembered',
    email: 'admin@example.com',
    persistence: 'memory-only'
  })
})

test('an empty, unreadable, or unreachable store reads as its Domain outcome', async () => {
  const rememberedEmails = createRememberedEmailPersistenceOverIpc()

  installWindowApi(async () => ({ outcome: 'empty' }))
  assert.deepEqual(await rememberedEmails.read(), { outcome: 'empty' })

  installWindowApi(async () => ({ outcome: 'unreadable' }))
  assert.deepEqual(await rememberedEmails.read(), { outcome: 'unreadable' })

  installWindowApi(async () => ({ outcome: 'storage-unavailable' }))
  assert.deepEqual(await rememberedEmails.read(), { outcome: 'unavailable' })

  installWindowApi(async () => {
    throw new Error('ipc failed')
  })
  assert.deepEqual(await rememberedEmails.read(), { outcome: 'unavailable' })
})

test('replacement reports persisted, memory-only, or a failed write', async () => {
  const rememberedEmails = createRememberedEmailPersistenceOverIpc()
  const { calls } = installWindowApi(async () => ({ outcome: 'persisted' }))

  assert.deepEqual(await rememberedEmails.replace('admin@example.com'), { outcome: 'persisted' })
  assert.deepEqual(calls, [
    { channel: 'authentication:replace-remembered-email', request: { email: 'admin@example.com' } }
  ])

  installWindowApi(async () => ({ outcome: 'memory-only' }))
  assert.deepEqual(await rememberedEmails.replace('admin@example.com'), { outcome: 'memory-only' })

  installWindowApi(async () => {
    throw new Error('ipc failed')
  })
  assert.deepEqual(await rememberedEmails.replace('admin@example.com'), {
    outcome: 'replace-failed'
  })
})

test('clearing reports whether the remembered value was removed', async () => {
  const rememberedEmails = createRememberedEmailPersistenceOverIpc()
  const { calls } = installWindowApi(async () => ({ outcome: 'cleared' }))

  assert.deepEqual(await rememberedEmails.clear(), { outcome: 'cleared' })
  assert.deepEqual(calls, [{ channel: 'authentication:clear-remembered-email' }])

  installWindowApi(async () => ({ outcome: 'clear-failed' }))
  assert.deepEqual(await rememberedEmails.clear(), { outcome: 'clear-failed' })

  installWindowApi(async () => {
    throw new Error('ipc failed')
  })
  assert.deepEqual(await rememberedEmails.clear(), { outcome: 'clear-failed' })
})
