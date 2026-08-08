import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'

test('@smoke launchTestApp waits for the renderer to commit content', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-renderer-readiness-'))
  const { electronApp, page } = await launchTestApp({
    userDataDir,
    systemLanguages: ['en-US']
  })

  try {
    const rendererIsReady = await page.evaluate(() => {
      return (
        document.readyState !== 'loading' &&
        (document.querySelector('#root')?.childElementCount ?? 0) > 0
      )
    })
    expect(rendererIsReady).toBe(true)
  } finally {
    await electronApp.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})
