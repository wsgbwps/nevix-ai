import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'

test('the real Authentication BrowserWindow has hardened web preferences', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SUPABASE_URL,
    'requires the configured build produced by the Auth test command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-security-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US']
    })

    try {
      const preferences = await launched.electronApp.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window) throw new Error('Main window was not created')
        const webPreferences = window.webContents.getLastWebPreferences()
        return {
          sandbox: webPreferences.sandbox,
          contextIsolation: webPreferences.contextIsolation,
          nodeIntegration: webPreferences.nodeIntegration,
          webSecurity: webPreferences.webSecurity
        }
      })

      expect(preferences).toEqual({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true
      })
      expect(
        await launched.page.evaluate(() => ({
          apiKeys: Object.keys(window.api).sort(),
          hasNodeProcess: 'process' in window,
          hasAuthenticationBridge: 'authentication' in window
        }))
      ).toEqual({
        apiKeys: ['invoke', 'on'],
        hasNodeProcess: false,
        hasAuthenticationBridge: false
      })
      expect(
        await launched.electronApp.evaluate(
          () => process.env.NEVIX_TEST_SUPABASE_SERVICE_ROLE_KEY ?? null
        )
      ).toBeNull()

      const originalUrl = launched.page.url()
      expect(await launched.page.evaluate(() => window.open('https://example.com') === null)).toBe(
        true
      )
      await launched.page.evaluate(() => window.location.assign('https://example.com'))
      await expect.poll(() => launched.page.url()).toBe(originalUrl)
      expect(await launched.page.evaluate(() => Notification.requestPermission())).toBe('denied')
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('CSP allows only this build Supabase origin and blocks a sentinel origin', async () => {
  const supabaseUrl = process.env.NEVIX_TEST_SUPABASE_URL
  test.skip(!supabaseUrl, 'requires the disposable Supabase Auth harness')
  if (!supabaseUrl) return

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-csp-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US']
    })

    try {
      const result = await launched.page.evaluate(async (allowedOrigin) => {
        const policy =
          document
            .querySelector('meta[http-equiv="Content-Security-Policy"]')
            ?.getAttribute('content') ?? ''
        const violation = new Promise<{ directive: string; blockedUri: string }>((resolve) => {
          document.addEventListener(
            'securitypolicyviolation',
            (event) => {
              resolve({
                directive: event.effectiveDirective,
                blockedUri: event.blockedURI
              })
            },
            { once: true }
          )
        })

        const allowedResponse = await fetch(`${allowedOrigin}/auth/v1/health`)
        let sentinelFetchRejected = false
        try {
          await fetch('https://csp-sentinel.invalid/auth/v1/health')
        } catch {
          sentinelFetchRejected = true
        }

        return {
          policy,
          allowedResponseOk: allowedResponse.ok,
          sentinelFetchRejected,
          violation: await violation
        }
      }, supabaseUrl)

      expect(result.allowedResponseOk).toBe(true)
      expect(result.sentinelFetchRejected).toBe(true)
      expect(result.violation).toEqual({
        directive: 'connect-src',
        blockedUri: 'https://csp-sentinel.invalid/auth/v1/health'
      })

      const connectSource = result.policy
        .split(';')
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith('connect-src '))
      expect(connectSource).toBe(`connect-src ${new URL(supabaseUrl).origin}`)
      expect(connectSource).not.toContain('*')
      expect(connectSource).not.toMatch(/(?:^|\s)(?:http:|https:|ws:|wss:)(?:\s|$)/)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
