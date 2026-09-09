import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerHooks } from 'node:module'

const electronStub = `data:text/javascript,${encodeURIComponent(`
export const app = {
  isPackaged: false,
  getPath: () => globalThis.__nevixSessionRoot
}
export const safeStorage = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => 'unavailable',
  setUsePlainTextEncryption: () => undefined,
  encryptString: () => { throw new Error('unavailable') },
  decryptString: () => { throw new Error('unavailable') }
}
`)}`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: electronStub, shortCircuit: true }
    const isDesktopSource = context.parentURL?.includes('/apps/desktop/src/') === true
    const resolvedSpecifier =
      isDesktopSource && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)
        ? `${specifier}.ts`
        : specifier
    return nextResolve(resolvedSpecifier, context)
  }
})

test('Main keeps the live Session when secure restart persistence is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nevix-main-session-'))
  ;(globalThis as typeof globalThis & { __nevixSessionRoot?: string }).__nevixSessionRoot = root
  process.env.NEVIX_E2E = '1'
  process.env.NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE = '1'
  try {
    const authentication = await import('../../src/main/authentication/index.ts')
    const session = JSON.stringify({
      token: 'live-session-token',
      expires_at: '2026-09-10T00:00:00Z',
      user: { id: 'user-1', email: 'creator@example.com' }
    })

    assert.deepEqual(await authentication.replaceCurrentSession(session), {
      outcome: 'unavailable'
    })
    assert.equal(await authentication.readCurrentSessionToken(), 'live-session-token')

    await authentication.clearCurrentSession()
    assert.equal(await authentication.readCurrentSessionToken(), undefined)
  } finally {
    delete process.env.NEVIX_E2E
    delete process.env.NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE
    await rm(root, { recursive: true, force: true })
  }
})
