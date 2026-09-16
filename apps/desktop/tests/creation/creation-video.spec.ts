import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import {
  createStableTeamUser,
  readIdentityServerConfig,
  uniqueIdentity
} from '../auth/helpers/identity-server'

const server = readIdentityServerConfig()

test(
  'a creator generates, plays and downloads an audio-bearing video',
  { tag: '@video' },
  async () => {
    test.setTimeout(180_000)
    test.skip(!server, 'requires the disposable server built by the E2E command')
    if (!server) return
    const identity = uniqueIdentity('creation-video')
    await createStableTeamUser(server, identity)
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-creation-video-'))
    const downloadDir = await mkdtemp(join(tmpdir(), 'nevix-video-download-'))
    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['zh-CN'],
        serverUrl: server.serverUrl
      })
      try {
        await launched.page.getByLabel('邮箱').fill(identity.email)
        await launched.page.getByLabel('密码').fill(identity.password)
        await launched.page.getByRole('button', { name: '登录', exact: true }).click()
        await expect(
          launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })
        ).toBeVisible()
        await launched.page.getByRole('link', { name: 'AI 创作' }).click()
        const workbench = launched.page.getByTestId('creation-workbench')
        await expect(workbench).toBeVisible()
        await workbench.getByTestId('session-new').click()
        await workbench.getByTestId('composer-prompt').fill('秋季商品运镜，保留场景声音')
        await workbench.getByTestId('composer-media').click()
        await launched.page.getByRole('menuitem', { name: '视频生成' }).click()
        await expect(workbench.getByTestId('composer-mode')).toContainText('首尾帧')
        await launched.electronApp.evaluate(({ session }, dir) => {
          session.defaultSession.on('will-download', (_event, item) =>
            item.setSavePath(`${dir}/result.mp4`)
          )
        }, downloadDir)
        await expect(workbench.getByTestId('composer-submit')).toBeEnabled({ timeout: 15_000 })
        await workbench.getByTestId('composer-submit').click()
        const slot = launched.page.locator('[data-slot-status="succeeded"]')
        await expect(slot).toHaveCount(1, { timeout: 60_000 })
        const video = slot.locator('video')
        await expect(video).toBeVisible()
        await expect
          .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), {
            timeout: 30_000
          })
          .toBeGreaterThanOrEqual(2)
        const facts = await video.evaluate(async (element: HTMLVideoElement) => {
          element.muted = true
          await element.play()
          return {
            width: element.videoWidth,
            height: element.videoHeight,
            duration: element.duration,
            paused: element.paused
          }
        })
        expect(facts).toEqual({ width: 320, height: 180, duration: 5, paused: false })
        await expect
          .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
          .toBeGreaterThan(0)
        await slot.getByTestId(/slot-download-/).click()
        const savedPath = join(downloadDir, 'result.mp4')
        const fixture = readFileSync(
          join(__dirname, '../../../../scripts/dev/fixtures/video-with-audio.mp4')
        )
        await expect
          .poll(
            () => {
              try {
                return readFileSync(savedPath).length
              } catch {
                return 0
              }
            },
            { timeout: 30_000 }
          )
          .toBe(fixture.length)
        expect(readFileSync(savedPath).equals(fixture)).toBe(true)
        expect(readFileSync(savedPath).includes(Buffer.from('soun'))).toBe(true)
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await rm(downloadDir, { recursive: true, force: true })
    }
  }
)
