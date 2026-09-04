import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasSecurePersistenceBackend, launchTestApp } from '../helpers/electron-app'

const SESSION_FILE_NAME = 'authentication-session.enc'
const REMEMBERED_EMAIL_FILE_NAME = 'authentication-remembered-email.enc'

test('@native-smoke native credential storage encrypts, restores, and clears both records', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-native-secure-persistence-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)
  const rememberedEmailPath = join(userDataDir, REMEMBERED_EMAIL_FILE_NAME)
  const sessionEmail = 'native-session@example.invalid'
  const rememberedEmail = 'native-remembered@example.invalid'
  const userId = 'native-smoke-user'
  const token = 'native-smoke-opaque-token-never-plaintext'
  const session = JSON.stringify({
    token,
    expires_at: '2099-01-01T00:00:00.000Z',
    user: { id: userId, email: sessionEmail }
  })
  let electronApp: ElectronApplication | undefined

  try {
    const first = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    electronApp = first.electronApp
    expect(
      await hasSecurePersistenceBackend(electronApp),
      'Native Smoke requires an available Keychain or DPAPI backend'
    ).toBe(true)

    expect(
      await invokeAuthenticationChannel(first.page, 'authentication:replace-session', {
        session
      })
    ).toEqual({ outcome: 'persisted' })
    expect(
      await invokeAuthenticationChannel(first.page, 'authentication:replace-remembered-email', {
        email: rememberedEmail
      })
    ).toEqual({ outcome: 'persisted' })

    expectEncryptedEnvelope(await readFile(sessionPath, 'utf8'), [token, userId, sessionEmail])
    expectEncryptedEnvelope(await readFile(rememberedEmailPath, 'utf8'), [rememberedEmail])

    await electronApp.close()
    electronApp = undefined

    const second = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    electronApp = second.electronApp
    expect(await invokeAuthenticationChannel(second.page, 'authentication:read-session')).toEqual({
      outcome: 'session',
      session
    })
    expect(
      await invokeAuthenticationChannel(second.page, 'authentication:read-remembered-email')
    ).toEqual({
      outcome: 'email',
      email: rememberedEmail,
      persistence: 'secure'
    })

    await invokeAuthenticationChannel(second.page, 'authentication:clear-session')
    expect(
      await invokeAuthenticationChannel(second.page, 'authentication:clear-remembered-email')
    ).toEqual({ outcome: 'cleared' })
    await expectFileMissing(sessionPath)
    await expectFileMissing(rememberedEmailPath)
  } finally {
    await electronApp?.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true })
  }
})

async function invokeAuthenticationChannel(
  page: Page,
  channel: string,
  request?: unknown
): Promise<unknown> {
  return page.evaluate(
    ({ channel, request }) => {
      const bridge = window as unknown as {
        api: { invoke: (channel: string, request?: unknown) => Promise<unknown> }
      }
      return request === undefined
        ? bridge.api.invoke(channel)
        : bridge.api.invoke(channel, request)
    },
    { channel, request }
  )
}

function expectEncryptedEnvelope(envelope: string, forbiddenValues: readonly string[]): void {
  const parsed = JSON.parse(envelope) as Record<string, unknown>
  expect(Object.keys(parsed).sort()).toEqual(['ciphertext', 'version'])
  expect(parsed.version).toBe(1)
  expect(parsed.ciphertext).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  for (const value of forbiddenValues) expect(envelope).not.toContain(value)
}

async function expectFileMissing(path: string): Promise<void> {
  await expect.poll(() => fileExists(path)).toBe(false)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
