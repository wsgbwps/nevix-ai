import { expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'

const WINDOW_STATE_FILE = 'window-state.json'

async function readWindowBounds(
  electronApp: ElectronApplication
): Promise<{ x: number; y: number; width: number; height: number }> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('Main window was not created')
    return window.getBounds()
  })
}

test('first launch uses the default bounds of 1280x800', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-window-default-'))
  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      const bounds = await readWindowBounds(launched.electronApp)
      expect(bounds.width).toBe(1280)
      expect(bounds.height).toBe(800)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('@native-smoke restores persisted bounds across restarts', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-window-restore-'))
  try {
    const first = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await first.electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 80, y: 80, width: 1100, height: 700 })
      })
    } finally {
      await first.electronApp.close()
    }

    const second = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      const bounds = await readWindowBounds(second.electronApp)
      expect(bounds).toEqual({ x: 80, y: 80, width: 1100, height: 700 })
    } finally {
      await second.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('clamps the window to the configured minimum size', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-window-min-'))
  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await launched.electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(300, 200)
      })
      await expect
        .poll(async () => {
          const bounds = await readWindowBounds(launched.electronApp)
          return { width: bounds.width, height: bounds.height }
        })
        .toEqual({ width: 960, height: 600 })
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('falls back to default bounds when the persisted state is corrupt', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-window-corrupt-'))
  try {
    await writeFile(join(userDataDir, WINDOW_STATE_FILE), '{not valid json', 'utf8')
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      const bounds = await readWindowBounds(launched.electronApp)
      expect(bounds.width).toBe(1280)
      expect(bounds.height).toBe(800)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
