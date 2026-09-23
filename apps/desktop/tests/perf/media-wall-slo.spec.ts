import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import { readIdentityServerConfig } from '../auth/helpers/identity-server'

/**
 * Issue #292 — the media-display SLO benchmark.
 *
 * Measures the shipped wall behaviour on the real Electron Renderer → Go → OSS
 * topology. Everything below is test-side: no renderer or server instrumentation
 * exists for this, and criterion 14 forbids adding any, so timing comes from an
 * in-page observer this spec injects and reads back once per measurement.
 *
 * Both walls default to their image filter, and the media-type pair is a strict
 * image|video choice with no "all" — so one route entry yields two measured
 * phases:
 *   image — entering the route, which is the 320px image wall criteria 5, 6 and
 *           11 describe, and the route entry criteria 3 and 4 are about;
 *   video — selecting 视频 on the same wall, which is the only state that mounts
 *           a <video>, and therefore the only state criterion 7 can measure.
 *
 * Reported values are positional indices, timings, and byte counts. Signed URLs,
 * object keys, Asset identities, prompts, and credentials never leave the page
 * (criterion 12): resource names are reduced to their origin.
 *
 * Run it through `bash scripts/run-e2e.sh benchmark`, the only mode that builds
 * the production server and registers a real Object Storage connection. The E2E
 * build's blob store refuses to presign, so a display URL cannot exist there.
 */

const server = readIdentityServerConfig()

const COLD_ENTRIES = Number(process.env.NEVIX_BENCHMARK_COLD ?? 30)
const WARM_ENTRIES = Number(process.env.NEVIX_BENCHMARK_WARM ?? 30)
const ENTRY_SETTLE_MS = Number(process.env.NEVIX_BENCHMARK_SETTLE_MS ?? 20_000)

const ROUTES = {
  assets: { label: '资产', filterBar: 'asset-filters', card: 'asset-card' },
  inspiration: { label: '灵感', filterBar: 'inspiration-page', card: 'inspiration-card' }
} as const

type RouteKind = keyof typeof ROUTES
type Phase = 'image' | 'video'

/** The observed card shape the in-page recorder hands back. */
interface CardSample {
  readonly index: number
  readonly mediaKind: 'image' | 'video'
  readonly initiallyVisible: boolean
  readonly appearedAt: number
  readonly decodedAt: number | null
  readonly loadedMetadataAt: number | null
  readonly hoverEnteredAt: number | null
  readonly playingAt: number | null
  readonly failed: 'retryable' | 'unavailable' | null
}

interface EntrySample {
  readonly route: RouteKind
  readonly phase: Phase
  readonly mode: 'cold' | 'warm'
  readonly index: number
  readonly t0: number
  readonly cards: readonly CardSample[]
  readonly devicePixelRatio: number
}

/**
 * One transport observation. Byte counts come from `Content-Length` rather than
 * `PerformanceResourceTiming.transferSize`, which is structurally 0 here: the
 * renderer is a `file://` document, every request is therefore cross-origin, and
 * Aliyun OSS sends no `Timing-Allow-Origin`.
 */
interface NetworkSample {
  readonly origin: string
  readonly resourceType: string
  readonly status: number
  readonly range: string
  readonly contentRange: string
  readonly contentLength: number
}

/**
 * Installed into the page once, before the first timed entry. It must stay
 * self-contained: Playwright ships this function's source into the page, so it
 * cannot close over anything declared here.
 */
function installRecorder(): void {
  type Rec = {
    index: number
    element: Element
    mediaKind: 'image' | 'video'
    initiallyVisible: boolean
    appearedAt: number
    decodedAt: number | null
    loadedMetadataAt: number | null
    hoverEnteredAt: number | null
    playingAt: number | null
    failed: 'retryable' | 'unavailable' | null
  }
  type State = {
    route: string
    t0: number
    cards: Rec[]
    failedText: string
    goneText: string
  }

  const bench = {
    state: null as State | null,
    arm(route: string, selector: string, failedText: string, goneText: string): number {
      document.querySelectorAll('[data-bench-card]').forEach((node) => {
        node.removeAttribute('data-bench-card')
      })
      const state: State = { route, t0: performance.now(), cards: [], failedText, goneText }
      bench.state = state

      const byElement = new WeakMap<Element, Rec>()
      let nextIndex = 0

      const classify = (text: string): Rec['failed'] =>
        text.includes(failedText) ? 'retryable' : text.includes(goneText) ? 'unavailable' : null

      const watchMedia = (record: Rec, media: HTMLMediaElement): void => {
        if (media instanceof HTMLImageElement) {
          if (media.complete && media.naturalWidth > 0) record.decodedAt = performance.now()
          media.addEventListener('load', () => (record.decodedAt = performance.now()), {
            once: true
          })
          media.addEventListener(
            'error',
            () => (record.failed ??= classify(record.element.textContent ?? '')),
            { once: true }
          )
          return
        }
        // A video's visible frame is `loadeddata`, matching the app's own gate.
        // `loadedmetadata` is recorded separately: it proves the moov index
        // parsed, and nothing about a paintable frame.
        if (media.readyState >= HTMLMediaElement.HAVE_METADATA) {
          record.loadedMetadataAt = performance.now()
        }
        if (media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          record.decodedAt = performance.now()
        }
        media.addEventListener(
          'loadedmetadata',
          () => (record.loadedMetadataAt ??= performance.now()),
          { once: true }
        )
        media.addEventListener('loadeddata', () => (record.decodedAt ??= performance.now()), {
          once: true
        })
        media.addEventListener('playing', () => (record.playingAt ??= performance.now()), {
          once: true
        })
        media.addEventListener(
          'error',
          () => (record.failed ??= classify(record.element.textContent ?? '')),
          { once: true }
        )
      }

      const adopt = (element: Element): void => {
        if (byElement.has(element)) return
        const record: Rec = {
          index: nextIndex,
          element,
          mediaKind: element.querySelector('video') !== null ? 'video' : 'image',
          initiallyVisible: false,
          appearedAt: performance.now(),
          decodedAt: null,
          loadedMetadataAt: null,
          hoverEnteredAt: null,
          playingAt: null,
          failed: classify(element.textContent ?? '')
        }
        nextIndex += 1
        element.setAttribute('data-bench-card', String(record.index))
        byElement.set(element, record)
        state.cards.push(record)

        element.addEventListener(
          'pointerenter',
          () => (record.hoverEnteredAt ??= performance.now())
        )

        const attach = (): boolean => {
          const media = element.querySelector('img, video')
          if (media === null) return false
          record.mediaKind = media instanceof HTMLVideoElement ? 'video' : 'image'
          watchMedia(record, media as HTMLMediaElement)
          return true
        }
        if (!attach()) {
          const observer = new MutationObserver(() => {
            if (attach()) observer.disconnect()
          })
          observer.observe(element, { childList: true, subtree: true })
        }
      }

      // Zero rootMargin is what makes "intersecting the initial viewport at
      // route entry" observable without scrolling: the benchmark never scrolls
      // the wall, so a card that intersects is a card that was above the fold.
      const viewport = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const record = byElement.get(entry.target)
            if (record !== undefined && entry.isIntersecting) record.initiallyVisible = true
          }
        },
        { rootMargin: '0px', threshold: 0 }
      )
      const watcher = new MutationObserver(() => {
        document.querySelectorAll(selector).forEach((element) => {
          if (byElement.has(element)) return
          adopt(element)
          viewport.observe(element)
        })
      })
      document.querySelectorAll(selector).forEach((element) => {
        adopt(element)
        viewport.observe(element)
      })
      watcher.observe(document.body, { childList: true, subtree: true })

      return state.t0
    },
    report(): unknown {
      const state = bench.state
      if (state === null) return null
      return {
        route: state.route,
        t0: state.t0,
        devicePixelRatio: window.devicePixelRatio,
        // Switching the media filter re-renders the wall, so cards from the
        // phase now on screen are the only ones this measurement owns.
        cards: state.cards
          .filter((record) => record.element.isConnected)
          .map((record) => ({
            index: record.index,
            mediaKind: record.mediaKind,
            initiallyVisible: record.initiallyVisible,
            appearedAt: record.appearedAt,
            decodedAt: record.decodedAt,
            loadedMetadataAt: record.loadedMetadataAt,
            hoverEnteredAt: record.hoverEnteredAt,
            playingAt: record.playingAt,
            failed: record.failed
          }))
      }
    }
  }
  ;(window as unknown as { __nevixBench: typeof bench }).__nevixBench = bench
}

/** The recorder's typed surface, as the spec reaches it through `page.evaluate`. */
type BenchGlobal = {
  __nevixBench: {
    arm(route: string, selector: string, failed: string, gone: string): number
    report(): {
      route: string
      t0: number
      devicePixelRatio: number
      cards: CardSample[]
    }
  }
}

async function armEntry(page: Page, route: RouteKind): Promise<number> {
  // The two status strings are the app's `assets.mediaFailed` /
  // `assets.mediaUnavailable` under the zh-CN interface this spec selects.
  return page.evaluate(
    ([kind, card]) =>
      (window as unknown as BenchGlobal).__nevixBench.arm(
        kind as string,
        `[data-testid="${card as string}"]`,
        '媒体加载失败',
        '媒体不可用'
      ),
    [route, ROUTES[route].card] as const
  )
}

async function readReport(page: Page): Promise<{
  t0: number
  devicePixelRatio: number
  cards: CardSample[]
}> {
  return page.evaluate(() => (window as unknown as BenchGlobal).__nevixBench.report())
}

/** Selects one media type on the wall currently mounted. */
async function selectMedia(page: Page, route: RouteKind, label: string): Promise<void> {
  await page
    .getByTestId(ROUTES[route].filterBar)
    .getByRole('button', { name: label, exact: true })
    .click()
}

/** Waits until every card has resolved — decoded or failed — or the budget ends. */
async function settle(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const report = await readReport(page)
        if (report.cards.length === 0) return false
        return report.cards.every((card) => card.decodedAt !== null || card.failed !== null)
      },
      { timeout: ENTRY_SETTLE_MS, intervals: [100] }
    )
    .toBe(true)
    .catch(() => undefined)
}

/**
 * Criterion 7: pointer-enter to video motion. Both ends are the page's own
 * timestamps — `pointerenter` and the media element's `playing` — so a real
 * pointer move is measured with no Playwright round-trip inside it.
 */
async function measureHover(page: Page): Promise<void> {
  const indices = (await readReport(page)).cards
    .filter((card) => card.initiallyVisible && card.mediaKind === 'video')
    .map((card) => card.index)
  for (const index of indices) {
    const card = page.locator(`[data-bench-card="${index}"]`)
    if ((await card.count()) === 0) continue
    await card.hover({ timeout: 5_000 }).catch(() => undefined)
    await expect
      .poll(
        async () => {
          const report = await readReport(page)
          return report.cards.find((entry) => entry.index === index)?.playingAt ?? null
        },
        { timeout: 10_000, intervals: [50] }
      )
      .not.toBeNull()
      .catch(() => undefined)
    await page.mouse.move(0, 0)
  }
}

test(
  'the media wall meets its first-screen and hover SLOs on the real OSS path',
  { tag: '@benchmark' },
  async () => {
    test.setTimeout(3_600_000)
    test.skip(!server, 'requires the disposable server built by the E2E command')
    test.skip(
      process.env.NEVIX_BENCHMARK !== '1',
      'requires `bash scripts/run-e2e.sh benchmark`, which builds the production server and registers a real Object Storage connection'
    )
    if (!server) return

    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-benchmark-'))
    const outputDir = join(__dirname, '..', '..', 'test-results', 'media-wall-benchmark')
    await mkdir(outputDir, { recursive: true })

    let app: ElectronApplication | undefined
    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['zh-CN'],
        serverUrl: server.serverUrl
      })
      app = launched.electronApp
      const page = launched.page
      // Evaluated rather than added as an init script: the renderer is a single
      // document for the whole run, and the app is already mounted by now.
      await page.evaluate(installRecorder)

      // The harness's own admin: it owns what it generates, so the Asset Library
      // is a real creator wall, and its Inspiration view is the Admin governance
      // wall over every non-deleted asset — both populated by the same seeding.
      await page.getByLabel('邮箱').fill(server.adminEmail)
      await page.getByLabel('密码').fill(server.adminPassword)
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await expect(page.getByRole('heading', { name: '灵感' })).toBeVisible()

      // Seed real media through the real pipeline. The provider is the harness's
      // loopback fake, which the production server is pointed at; everything on
      // the far side of the provider — admission, transfer, the real OSS adapter,
      // the Media Asset — is the shipped path.
      const submit = async (prompt: string, video: boolean): Promise<void> => {
        await page.getByTestId('session-new').click()
        const workbench = page.getByTestId('creation-workbench')
        await expect(workbench).toBeVisible()
        await workbench.getByTestId('composer-prompt').fill(prompt)
        if (video) {
          await workbench.getByTestId('composer-media').click()
          await page.getByRole('menuitem', { name: '视频生成' }).click()
          // Confirm the media switch took, instead of assuming the click landed
          // and silently submitting one more image task.
          await expect(workbench.getByTestId('composer-mode')).toContainText('首尾帧')
        } else {
          await workbench.getByTestId('composer-params').click()
          await page.getByRole('menu').getByRole('button', { name: '2', exact: true }).click()
          await page.keyboard.press('Escape')
        }
        await expect(workbench.getByTestId('composer-submit')).toBeEnabled({ timeout: 15_000 })
        const before = await page.locator('[data-slot-status="succeeded"]').count()
        await workbench.getByTestId('composer-submit').click()
        await expect
          .poll(() => page.locator('[data-slot-status="succeeded"]').count(), {
            timeout: 180_000,
            intervals: [500]
          })
          .toBeGreaterThan(before)
      }
      for (let index = 0; index < 4; index += 1) {
        await submit(`基准图片素材 ${index}，冷调布光`, false)
      }
      // One video is enough to measure criterion 7, and a wall this size already
      // puts it above the fold so it counts as initially visible.
      await submit('基准视频素材，运镜', true)

      await page.getByRole('link', { name: ROUTES.assets.label }).click()
      await expect(page.getByTestId(ROUTES.assets.card).first()).toBeVisible({ timeout: 30_000 })

      const entries: EntrySample[] = []
      // Transport evidence for criterion 9: the media and image bodies the wall
      // actually pulled, which is what the 320px WebP wall and the original-MP4
      // video wall differ in. Ordinary JSON list calls are not part of it.
      const network: NetworkSample[] = []
      page.on('response', (response) => {
        const headers = response.headers()
        const request = response.request()
        const range = request.headers()['range'] ?? ''
        const contentRange = headers['content-range'] ?? ''
        const resourceType = request.resourceType()
        if (
          range === '' &&
          contentRange === '' &&
          resourceType !== 'media' &&
          resourceType !== 'image'
        ) {
          return
        }
        let origin = ''
        try {
          origin = new URL(response.url()).origin
        } catch {
          origin = ''
        }
        network.push({
          origin,
          resourceType,
          status: response.status(),
          range,
          contentRange,
          contentLength: Number(headers['content-length'] ?? 0)
        })
      })

      const record = async (
        route: RouteKind,
        phase: Phase,
        mode: 'cold' | 'warm',
        index: number,
        t0: number
      ): Promise<void> => {
        const report = await readReport(page)
        entries.push({
          route,
          phase,
          mode,
          index,
          t0,
          cards: report.cards,
          devicePixelRatio: report.devicePixelRatio
        })
        await writeFile(
          join(outputDir, 'report.json'),
          JSON.stringify({ entries, network }, null, 2)
        )
      }

      const runEntry = async (
        route: RouteKind,
        mode: 'cold' | 'warm',
        index: number
      ): Promise<void> => {
        // Leave the wall first, so the entry under measurement is a real route
        // entry rather than a re-render of the wall already on screen.
        const away: RouteKind = route === 'assets' ? 'inspiration' : 'assets'
        await page.getByRole('link', { name: ROUTES[away].label }).first().click()
        await expect(page.getByTestId(ROUTES[away].card).first()).toBeVisible({ timeout: 30_000 })
        // A cold entry starts with no cached media. A warm entry keeps whatever
        // this Session has already fetched, which is the whole distinction.
        if (mode === 'cold') {
          await app?.evaluate(({ session }) => session.defaultSession.clearCache())
        }

        const imageT0 = await armEntry(page, route)
        await page.getByRole('link', { name: ROUTES[route].label }).first().click()
        await settle(page)
        await record(route, 'image', mode, index, imageT0)

        // The video phase arms before the filter click, so its metadata and data
        // timings are measured from the moment the video wall was asked for. The
        // hover measurement inside it is self-contained either way.
        const videoT0 = await armEntry(page, route)
        await selectMedia(page, route, '视频')
        await expect(page.getByTestId(ROUTES[route].card).first()).toBeVisible({ timeout: 30_000 })
        await settle(page)
        await measureHover(page)
        await record(route, 'video', mode, index, videoT0)
      }

      for (const mode of ['cold', 'warm'] as const) {
        const total = mode === 'cold' ? COLD_ENTRIES : WARM_ENTRIES
        for (let index = 0; index < total; index += 1) {
          await runEntry(index % 2 === 0 ? 'assets' : 'inspiration', mode, index)
        }
      }

      // Criterion 11: the 320px wall at a high device pixel ratio. Whether 320px
      // remains enough to recognise content is a judgement on the capture; this
      // only guarantees the capture is genuinely high-DPR and names what it was.
      await page.getByRole('link', { name: ROUTES.assets.label }).first().click()
      await settle(page)
      const dpr = await page.evaluate(() => window.devicePixelRatio)
      await page.screenshot({ path: join(outputDir, `wall-dpr${dpr}.png`), fullPage: true })

      expect(entries.length).toBe((COLD_ENTRIES + WARM_ENTRIES) * 2)
    } finally {
      if (app !== undefined) await app.close()
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

/**
 * The second half of criterion 8. A clean 60-entry sample can only report that
 * *no* failure happened; it cannot show that a failure would have been legible.
 * This injects a transport failure and is kept out of the performance sample
 * because route interception changes the timing it would be measuring.
 *
 * The generic unavailable verdict is deliberately not injected here; see the
 * note at its route below for why that is not a reachable server state, and
 * which test covers it instead.
 */
test(
  'injected media failures surface the explicit unavailable and retry states',
  { tag: '@benchmark' },
  async () => {
    test.setTimeout(900_000)
    test.skip(!server, 'requires the disposable server built by the E2E command')
    test.skip(process.env.NEVIX_BENCHMARK !== '1', 'requires `bash scripts/run-e2e.sh benchmark`')
    if (!server) return

    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-benchmark-failure-'))
    let app: ElectronApplication | undefined
    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['zh-CN'],
        serverUrl: server.serverUrl
      })
      app = launched.electronApp
      const page = launched.page
      await page.getByLabel('邮箱').fill(server.adminEmail)
      await page.getByLabel('密码').fill(server.adminPassword)
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await expect(page.getByRole('heading', { name: '灵感' })).toBeVisible()

      // Self-sufficient: this test must not depend on the seeding the performance
      // test happens to have done first.
      await page.getByTestId('session-new').click()
      const workbench = page.getByTestId('creation-workbench')
      await workbench.getByTestId('composer-prompt').fill('失败注入用素材')
      await expect(workbench.getByTestId('composer-submit')).toBeEnabled({ timeout: 15_000 })
      await workbench.getByTestId('composer-submit').click()
      await expect(page.locator('[data-slot-status="succeeded"]').first()).toBeVisible({
        timeout: 180_000
      })
      await page.getByRole('link', { name: ROUTES.assets.label }).click()

      const card = page.getByTestId(ROUTES.assets.card).first()
      const retry = card.getByRole('button', { name: '重试', exact: true })
      // Wall images ask for the thumbnail variant, so this is the call whose
      // failure decides the card's verdict.
      const authorization = /\/creation\/assets\/[^/]+\/thumbnail-url$/
      // Counted per Asset, so the assertion is about how many times one card asks
      // rather than about how many cards happen to be on screen.
      const attemptsByAsset = new Map<string, number>()
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname
        if (!authorization.test(path)) return
        attemptsByAsset.set(path, (attemptsByAsset.get(path) ?? 0) + 1)
      })
      // Re-entering the route remounts the wall, which is what forces a fresh
      // authorization rather than reusing a grant already in memory.
      const reenterWall = async (): Promise<void> => {
        await page.getByRole('link', { name: ROUTES.inspiration.label }).first().click()
        await expect(page.getByTestId(ROUTES.inspiration.card).first()).toBeVisible({
          timeout: 30_000
        })
        await page.getByRole('link', { name: ROUTES.assets.label }).first().click()
        await expect(card).toBeVisible({ timeout: 30_000 })
      }

      // A transport failure is the half this tier has to prove: the ladder runs
      // against the real Go server and the real bucket, so "exactly one automatic
      // re-authorization, then the manual retry the user can act on" is not a
      // fixture's opinion.
      //
      // The generic unavailable verdict is deliberately not injected here. A
      // synthetic refusal that never stops refusing is not a reachable server
      // state: the wall re-reads its list on `unavailable`, the refreshed list
      // still lists the Asset, so the card re-authorizes, is refused again and
      // the wall never converges. `asset-library.spec.tsx:418` covers that
      // verdict deterministically, against the port rather than the transport.
      // Reset first, so the counts below describe the injected phase alone.
      attemptsByAsset.clear()
      await page.route(authorization, async (route) => {
        if (route.request().method() !== 'GET') {
          await route.fallback()
          return
        }
        await route.abort('failed')
      })
      await reenterWall()
      await expect(card.getByText('媒体加载失败')).toBeVisible({ timeout: 30_000 })
      await expect(retry).toBeVisible({ timeout: 30_000 })
      // The exact count is not asserted: the renderer replays effects, so one
      // card may ask twice per attempt. What matters here is that a transport
      // failure stays bounded instead of becoming a retry loop, and that the
      // manual retry below is what resumes asking. The one-automatic-retry budget
      // itself is counted deterministically in
      // `apps/desktop/tests/component/asset-library.spec.tsx`.
      const afterFailure = Math.max(...attemptsByAsset.values())
      expect(afterFailure).toBeLessThanOrEqual(4)
      await page.unroute(authorization)

      await retry.click()
      // The recovery is the real grant rendering, not merely the button leaving.
      await expect(card.locator('img')).toBeVisible({ timeout: 30_000 })
      expect(Math.max(...attemptsByAsset.values())).toBeGreaterThan(afterFailure)
    } finally {
      if (app !== undefined) await app.close()
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)
